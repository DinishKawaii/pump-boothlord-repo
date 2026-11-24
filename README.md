[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/DinishKawaii/pump-boothlord-repo/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/DinishKawaii/pump-boothlord-repo/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — bot "naik-berlanjut, jual cepat"

Bot paper-trading untuk lomba [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) di make.fun. Bot ini berdagang memakai uang virtual (10 SOL) di atas replay data pump.fun — tanpa uang sungguhan.

## Strategi

Riset atas data dev kit (24 jam, 1222 koin) menunjukkan pompa koin baru
kebanyakan selesai dalam slot yang sama dengan pembuatannya, jadi membeli
semua koin baru selalu telat. Yang masih punya peluang: koin yang naiknya
**berlanjut** — harga naik vs 5 trade terakhir DAN vs 10 trade terakhir.

- **Beli**: satu kali per koin, saat harga naik berlanjut, umur koin <= 3600
  slot, dan batas ukuran (1% cadangan SOL asli) mengizinkan pembelian
  >= 0,01 SOL. Ukuran 0,1 SOL per koin, maksimal 5 posisi terbuka.
- **Jual**: semua token saat nilai posisi >= 1,2x biaya (take-profit),
  <= 0,85x biaya (stop-loss), atau sudah dipegang >= 900 slot (~6 menit).
- **Deterministik**: tanpa jam dan tanpa angka acak, jadi dua kali eksekusi
  memberi log aksi yang sama persis.

## Hasil uji lokal

`grade-local` atas data dev: net PnL -1,16 SOL, win rate 31%, 335 round
trips di 335 koin, max drawdown 0,13 — guardrails terpenuhi (minimal 20 koin,
drawdown di bawah 50%).

## File

- `main.ts` — strategi (entrypoint, dijalankan sebagai `node main.ts`)
- `vendor/makefun-bot.ts` — shim SDK agent-fun/replay/v2 (dari kit)
- `LICENSE` — MIT
