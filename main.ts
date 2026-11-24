// Bot paper-trading pump.fun — v3, strategi momentum "naik berlanjut".
//
// Cara baca pasarnya (dari data dev kit, 24 jam, 1222 koin):
// - Koin baru hampir selalu memuncak di slot yang sama dengan CreateEvent.
//   Membeli semua koin baru berarti selalu datang telat (bot v1: -3,8 SOL).
// - Yang masih menyimpan peluang: koin yang harganya TERUS naik — naik
//   dibanding 5 trade terakhir dan juga dibanding 10 trade terakhir.
//   Koin semacam ini median puncaknya 1,24x harga beli.
// - Karena harga berayun liar, jual dipasang pendek: take-profit 1,2x,
//   stop-loss 0,85x, dan jual paksa setelah dipegang ~6 menit (900 slot).
//   (Revisi setelah grade: TP 1,15 dicoba dan memberi -1,84 SOL, sedikit
//   lebih buruk dari TP 1,2 yang memberi -1,78 SOL — jadi TP dikembalikan
//   ke 1,2 sebagai versi final.)
//
// Cara bot bicara dengan harness (lewat shim SDK: hello, batch, orders, slot):
// - hello datang sekali di awal: memberi modal 10 SOL dan batas-batasnya.
// - Tiap batch membawa event slot itu (Create/Trade/Complete), posisi
//   terbaru, dan hasil order sebelumnya; bot membalas dengan daftar orders.
// - Order yang diputuskan di slot s baru terisi di slot s+2.
//
// Bedanya v3 dengan v2:
// - Urutan cek diperbaiki: kas dicek SEBELUM koin ditandai sudah diputuskan,
//   jadi koin tidak hilang sia-sia saat kas sedang habis (bug v2).
// - Order beli yang ditolak harness (fill "rejected") membebaskan koinnya
//   lagi, jadi sinyal yang masih berlaku bisa dicoba ulang (v2 tidak pernah
//   mencoba ulang).
// - Kode ditulis ulang penuh dengan struktur sendiri: pencatatan event,
//   keputusan jual, dan keputusan beli dipisah jadi tiga fungsi.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---- Angka-angka strategi ----
const STAKE = LAMPORTS_PER_SOL / 10n; // 0,1 SOL per koin
const MIN_BUY = LAMPORTS_PER_SOL / 100n; // 0,01 SOL, batas minimum round trip
const MAX_START_MULT = 5; // jangan kejar koin yang sudah >5x harga lahirnya
const MAX_COIN_AGE = 3600; // koin lebih tua dari ini tidak dibeli lagi
const NEED_POINTS = 11; // butuh 11 titik harga untuk membaca momentum
const RISE_VS_5 = 1.02; // harga kini > 1,02x harga 5 trade lalu
const RISE_VS_10 = 1.05; // dan > 1,05x harga 10 trade lalu
const TAKE_PROFIT = 1.2; // jual saat nilai posisi >= 1,2x biaya
const STOP_LOSS = 0.85; // jual saat nilai posisi <= 0,85x biaya
const MAX_HOLD = 900; // jual paksa setelah 900 slot (~6 menit)
const SLIPPAGE_BPS = 500;

// ---- Catatan per koin (disimpan sesuai urutan kemunculan, deterministik) ----
interface CoinNote {
  bornSlot: number; // slot CreateEvent (atau slot pertama kali terlihat)
  bornPrice: number; // harga SOL per token saat lahir
  prices: number[]; // harga tiap trade, paling banyak 12 terakhir
  boughtSlot: number | null; // slot saat order beli dikirim, null kalau belum
}

const notes = new Map<string, CoinNote>();
// Koin yang order belinya sudah dikirim dan belum ditolak — tidak dibeli dua kali.
const entered = new Set<string>();

function priceFrom(vToken: bigint, vQuote: bigint): number {
  const t = Number(vToken);
  const q = Number(vQuote);
  if (t <= 0 || q <= 0) return 0;
  return q / t;
}

// 1. Catat koin baru dan harga tiap trade dari event batch ini.
function noteEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (notes.has(e.mint)) continue;
      const p = priceFrom(BigInt(e.virtual_token_reserves), BigInt(e.virtual_quote_reserves));
      notes.set(e.mint, { bornSlot: e.slot, bornPrice: p, prices: [p], boughtSlot: null });
    } else if (e.event === 'TradeEvent') {
      const p = priceFrom(BigInt(e.virtual_token_reserves), BigInt(e.virtual_quote_reserves));
      if (p <= 0) continue;
      const note = notes.get(e.mint);
      if (note === undefined) {
        notes.set(e.mint, { bornSlot: e.slot, bornPrice: p, prices: [p], boughtSlot: null });
      } else {
        note.prices.push(p);
        if (note.prices.length > 12) note.prices.shift();
      }
    }
  }
}

// 2. Putuskan jual: posisi yang kena take-profit, stop-loss, atau batas waktu.
function exitOrders(state: BotState, batch: Batch, orders: Array<BuyInput | SellInput>): void {
  const selling = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') selling.add(p.order.mint);
  }
  const cap = state.hello.caps.max_orders_per_batch;
  for (const [mint, holding] of state.positions) {
    if (orders.length >= cap) return;
    if (selling.has(mint)) continue; // sudah ada order jual yang menunggu
    const curve = state.curves.get(mint);
    const note = notes.get(mint);
    if (curve === undefined || curve.complete || note === undefined) continue;
    const price = priceFrom(curve.virtual_token_reserves, curve.virtual_quote_reserves);
    if (price <= 0) continue;
    const cost = Number(holding.cost_lamports);
    if (cost <= 0) continue;
    const value = Number(holding.token_amount) * price;
    const ratio = value / cost;
    const held = note.boughtSlot === null ? 0 : batch.slot - note.boughtSlot;
    if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || held >= MAX_HOLD) {
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
    }
  }
}

// 3. Putuskan beli: koin yang momentumnya berlanjut, masih muda, dan
//    batas ukurannya sudah mengizinkan pembelian minimal 0,01 SOL.
function entryOrders(
  state: BotState,
  batch: Batch,
  orders: Array<BuyInput | SellInput>,
  freeCash: bigint,
  openSlots: number,
): void {
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = state.txFeeLamports();
  for (const [mint, note] of notes) {
    if (orders.length >= cap) return;
    if (openSlots <= 0) return;
    if (entered.has(mint)) continue;
    if (state.positions.has(mint)) {
      entered.add(mint);
      continue;
    }
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) {
      entered.add(mint);
      continue;
    }
    if (batch.slot - note.bornSlot > MAX_COIN_AGE) {
      entered.add(mint);
      continue;
    }
    const price = priceFrom(curve.virtual_token_reserves, curve.virtual_quote_reserves);
    if (price <= 0 || note.bornPrice <= 0) continue;
    if (price > MAX_START_MULT * note.bornPrice) {
      entered.add(mint);
      continue;
    }
    // Sinyal momentum: butuh 11 titik harga; harga kini naik vs 5 dan 10 trade lalu.
    const h = note.prices;
    if (h.length < NEED_POINTS) continue;
    const fiveBack = h[h.length - 6];
    const tenBack = h[0];
    if (!(price > fiveBack * RISE_VS_5 && price > tenBack * RISE_VS_10)) continue;
    // Batas ukuran 1% cadangan SOL asli harus mengizinkan minimal 0,01 SOL.
    const sizeCap = state.maxBuyLamports(mint);
    if (sizeCap < MIN_BUY) continue; // tunggu cadangan asli membesar
    const amount = sizeCap < STAKE ? sizeCap : STAKE;
    // Kas dicek SEBELUM koin ditandai — kalau kas kurang, koin tetap bisa
    // dicoba lagi di batch berikutnya (perbaikan dari v2).
    if (freeCash < amount + tx) continue;
    entered.add(mint);
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
    note.boughtSlot = batch.slot;
    freeCash -= amount + tx;
    openSlots -= 1;
  }
}

await runBot({
  onBatch(state, batch) {
    // Order beli yang ditolak harness membebaskan koinnya untuk dicoba lagi.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'rejected') entered.delete(f.mint);
    }

    noteEvents(batch);
    const orders: Array<BuyInput | SellInput> = [];
    exitOrders(state, batch, orders);
    entryOrders(
      state,
      batch,
      orders,
      state.freeCashLamports(),
      state.hello.caps.max_open_positions - state.committedPositionCount(),
    );
    return orders;
  },
});
