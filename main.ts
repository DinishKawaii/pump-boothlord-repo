// Bot paper-trading pump.fun — strategi "naik-berlanjut, jual cepat".
//
// Riset saya atas data dev kit ini (24 jam, 1222 koin):
// - Pompa koin baru kebanyakan selesai dalam slot yang sama dengan CreateEvent,
//   jadi bot yang membeli "semua koin baru" selalu telat dan rugi (diuji: -3,8 SOL).
// - Yang masih punya peluang: koin yang NAIKNYA BERLANJUT — harganya naik vs
//   5 trade terakhir DAN vs 10 trade terakhir. Koin seperti ini median
//   puncaknya 1,24x harga beli, 55% mencapai 1,2x.
// - Karena harga berayun liar (±15% itu biasa), take-profit dipasang pendek
//   (1,2x) dan stop-loss 0,85x, plus jual paksa setelah ~6 menit (900 slot).
//   Kombinasi ini yang paling baik dari ~100 kombinasi yang saya simulasikan
//   (dev -0,98 SOL — masih negatif, tapi paling kecil ruginya; pasar dev ini
//   memang keras untuk semua strategi tren yang saya coba).
// - Harga koin = virtual_quote_reserves / virtual_token_reserves.
// - Bot hanya bicara lewat shim SDK (hello, batch, orders, slot): hello memberi
//   modal dan batas; tiap batch membawa event dan posisi terbaru; bot membalas
//   dengan daftar orders untuk slot itu; order yang diputuskan di slot s
//   terisi di slot s+2.
//
// Aturan bot (revisi 2):
// - Beli: satu kali per koin, saat riwayat harganya menunjukkan kenaikan
//   berlanjut (harga kini > 1,02x harga 5 trade lalu dan > 1,05x harga
//   10 trade lalu), umur koin <= 3600 slot, dan batas ukuran (1% cadangan
//   SOL asli) sudah mengizinkan pembelian >= 0,01 SOL. Ukuran 0,1 SOL.
// - Jual semua token saat nilai posisi >= 1,2x biaya, atau <= 0,85x biaya,
//   atau sudah dipegang >= 900 slot.
// - Maksimal 5 posisi terbuka (batas harness), maksimal 16 orders per batch.
// - Deterministik penuh: tidak ada jam, tidak ada Math.random; urutan iterasi
//   mengikuti urutan kemunculan koin, jadi dua kali eksekusi memberi log aksi
//   yang sama persis.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// ---- parameter strategi (hasil simulasi offline atas data dev) ----
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n; // 0,1 SOL per koin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0,01 SOL, minimum round trip
const MAX_ENTRY_MULT = 5.0; // jangan kejar koin yang sudah >5x harga awal
const MAX_DECIDE_AGE_SLOTS = 3600; // koin lebih tua dari ini tidak lagi dibeli
const RISE_5 = 1.02; // harga kini harus > 1,02x harga 5 trade lalu
const RISE_10 = 1.05; // dan > 1,05x harga 10 trade lalu
const TAKE_PROFIT_MULT = 1.2; // jual saat nilai posisi >= 1,2x biaya
const STOP_LOSS_MULT = 0.85; // jual saat nilai posisi <= 0,85x biaya
const MAX_HOLD_SLOTS = 900; // jual paksa setelah ~6 menit
const MAX_SLIPPAGE_BPS = 500;

interface CoinInfo {
  createdSlot: number;
  createdPrice: number; // SOL per token saat CreateEvent
  buySlot: number | null; // slot saat order beli dikirim
  hist: number[]; // harga tiap trade, maksimal 12 terakhir
}

// Koin yang pernah terlihat, sesuai urutan kemunculan (deterministik).
const coins = new Map<string, CoinInfo>();
// Koin yang sudah diputuskan (dibeli atau dilewati) — tidak ditawar lagi.
const decided = new Set<string>();

function priceOf(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: Array<BuyInput | SellInput> = [];

    // 1. Catat koin baru dan riwayat harga dari event batch ini.
    //    hello sudah memberi modal; batch membawa CreateEvent/TradeEvent/
    //    CompleteEvent + posisi terbaru; orders yang kami balas terisi 2 slot lagi.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent' && !coins.has(e.mint)) {
        const vt = Number(e.virtual_token_reserves);
        const vq = Number(e.virtual_quote_reserves);
        const p = vt > 0 && vq > 0 ? vq / vt : 0;
        coins.set(e.mint, { createdSlot: e.slot, createdPrice: p, buySlot: null, hist: [p] });
      } else if (e.event === 'TradeEvent') {
        const info = coins.get(e.mint);
        if (info === undefined) {
          const vt = Number(e.virtual_token_reserves);
          const vq = Number(e.virtual_quote_reserves);
          const p = vt > 0 && vq > 0 ? vq / vt : 0;
          coins.set(e.mint, { createdSlot: e.slot, createdPrice: p, buySlot: null, hist: [p] });
        } else {
          const vt = Number(e.virtual_token_reserves);
          const vq = Number(e.virtual_quote_reserves);
          if (vt > 0 && vq > 0) {
            info.hist.push(vq / vt);
            if (info.hist.length > 12) info.hist.shift();
          }
        }
      }
    }

    // 2. Jual dulu: posisi yang sudah kena take-profit, stop-loss, atau batas waktu.
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      const info = coins.get(mint);
      if (curve === undefined || curve.complete || info === null || info === undefined) continue;
      const price = priceOf(curve);
      if (price <= 0) continue;
      const value = Number(holding.token_amount) * price;
      const cost = Number(holding.cost_lamports);
      if (cost <= 0) continue;
      const ratio = value / cost;
      const age = info.buySlot !== null ? batch.slot - info.buySlot : 0;
      if (ratio >= TAKE_PROFIT_MULT || ratio <= STOP_LOSS_MULT || age >= MAX_HOLD_SLOTS) {
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // 3. Beli: koin yang harganya naik berlanjut (momentum), masih muda,
    //    dan batas ukurannya sudah mengizinkan pembelian.
    for (const [mint, info] of coins) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (decided.has(mint)) continue;
      if (state.positions.has(mint)) {
        decided.add(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        decided.add(mint);
        continue;
      }
      const age = batch.slot - info.createdSlot;
      if (age > MAX_DECIDE_AGE_SLOTS) {
        decided.add(mint);
        continue;
      }
      const price = priceOf(curve);
      if (price <= 0 || info.createdPrice <= 0) continue;
      if (price > MAX_ENTRY_MULT * info.createdPrice) {
        decided.add(mint);
        continue;
      }
      // Sinyal momentum: butuh 11 titik harga, naik vs 5 dan 10 trade lalu.
      const h = info.hist;
      if (h.length < 11) continue;
      if (!(price > h[h.length - 6] * RISE_5 && price > h[0] * RISE_10)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue; // tunggu cadangan asli membesar
      decided.add(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      info.buySlot = batch.slot;
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
