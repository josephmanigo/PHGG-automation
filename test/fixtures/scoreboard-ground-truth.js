/**
 * Ground truth transcribed by hand from six real Bloodstrike endgame
 * screenshots (two rounds, each scrolled across three captures).
 *
 * Layout of one team row, left to right:
 *   [rank badge]  [slot letter]  [skull] [TEAM kill total]  then four player
 *   cells, each with its own name and its own kill count.
 *
 * Two things this pins down:
 *  - The number the tally needs is the TEAM total next to the slot letter, not
 *    any of the four per-player counts sitting to its right.
 *  - Ranks 1-3 show a medal badge instead of "#N", and every scrolled capture
 *    repeats the rank-1 row as a sticky header, so rows must be de-duplicated
 *    by rank across images.
 *
 * Verified: each team total equals the sum of its players' kills.
 */

export const ROUND_A = {
  label: 'round-a',
  captures: [
    {
      file: 'round-a-1.png',
      rows: [
        { rank: 1, slotLetter: 'A', kills: 58 },
        { rank: 2, slotLetter: 'O', kills: 12 },
        { rank: 3, slotLetter: 'I', kills: 14 },
        { rank: 4, slotLetter: 'L', kills: 38 },
        { rank: 5, slotLetter: 'T', kills: 3 },
        { rank: 6, slotLetter: 'V', kills: 30 },
        { rank: 7, slotLetter: 'U', kills: 13 },
        { rank: 8, slotLetter: 'Y', kills: 4 },
        { rank: 9, slotLetter: 'F', kills: 20 },
        { rank: 10, slotLetter: 'D', kills: 49 },
      ],
    },
    {
      file: 'round-a-2.png',
      stickyRank1: { rank: 1, slotLetter: 'A', kills: 58 },
      rows: [
        { rank: 11, slotLetter: 'J', kills: 31 },
        { rank: 12, slotLetter: 'E', kills: 12 },
        { rank: 13, slotLetter: 'N', kills: 24 },
        { rank: 14, slotLetter: 'H', kills: 24 },
        { rank: 15, slotLetter: 'C', kills: 11 },
        { rank: 16, slotLetter: 'M', kills: 22 },
        { rank: 17, slotLetter: 'B', kills: 5 },
        { rank: 18, slotLetter: 'X', kills: 8 },
        { rank: 19, slotLetter: 'Q', kills: 0 },
      ],
    },
    {
      file: 'round-a-3.png',
      stickyRank1: { rank: 1, slotLetter: 'A', kills: 58 },
      rows: [
        { rank: 13, slotLetter: 'N', kills: 24 },
        { rank: 14, slotLetter: 'H', kills: 24 },
        { rank: 15, slotLetter: 'C', kills: 11 },
        { rank: 16, slotLetter: 'M', kills: 22 },
        { rank: 17, slotLetter: 'B', kills: 5 },
        { rank: 18, slotLetter: 'X', kills: 8 },
        { rank: 19, slotLetter: 'Q', kills: 0 },
        { rank: 20, slotLetter: 'W', kills: 1 },
        { rank: 21, slotLetter: 'G', kills: 0 },
      ],
    },
  ],
}

export const ROUND_B = {
  label: 'round-b',
  captures: [
    {
      file: 'round-b-1.png',
      rows: [
        { rank: 1, slotLetter: 'A', kills: 56 },
        { rank: 2, slotLetter: 'F', kills: 41 },
        { rank: 3, slotLetter: 'L', kills: 26 },
        { rank: 4, slotLetter: 'O', kills: 21 },
        { rank: 5, slotLetter: 'U', kills: 12 },
        { rank: 6, slotLetter: 'J', kills: 35 },
        { rank: 7, slotLetter: 'G', kills: 35 },
        { rank: 8, slotLetter: 'N', kills: 13 },
        { rank: 9, slotLetter: 'E', kills: 15 },
        { rank: 10, slotLetter: 'V', kills: 23 },
      ],
    },
    {
      file: 'round-b-2.png',
      stickyRank1: { rank: 1, slotLetter: 'A', kills: 56 },
      rows: [
        { rank: 11, slotLetter: 'X', kills: 5 },
        { rank: 12, slotLetter: 'B', kills: 8 },
        { rank: 13, slotLetter: 'I', kills: 20 },
        { rank: 14, slotLetter: 'K', kills: 7 },
        { rank: 15, slotLetter: 'M', kills: 16 },
        { rank: 16, slotLetter: 'Q', kills: 10 },
        { rank: 17, slotLetter: 'C', kills: 7 },
        { rank: 18, slotLetter: 'T', kills: 2 },
        { rank: 19, slotLetter: 'Y', kills: 3 },
      ],
    },
    {
      file: 'round-b-3.png',
      stickyRank1: { rank: 1, slotLetter: 'A', kills: 56 },
      rows: [
        { rank: 13, slotLetter: 'I', kills: 20 },
        { rank: 14, slotLetter: 'K', kills: 7 },
        { rank: 15, slotLetter: 'M', kills: 16 },
        { rank: 16, slotLetter: 'Q', kills: 10 },
        { rank: 17, slotLetter: 'C', kills: 7 },
        { rank: 18, slotLetter: 'T', kills: 2 },
        { rank: 19, slotLetter: 'Y', kills: 3 },
        { rank: 20, slotLetter: 'D', kills: 6 },
        { rank: 21, slotLetter: 'H', kills: 5 },
      ],
    },
  ],
}

export const ROUNDS = [ROUND_A, ROUND_B]

/** Every distinct row of a round, de-duplicated by rank across its captures. */
export function expectedRoundRows(round) {
  const byRank = new Map()
  for (const capture of round.captures) {
    for (const row of capture.rows) byRank.set(row.rank, row)
  }
  return [...byRank.values()].sort((a, b) => a.rank - b.rank)
}
