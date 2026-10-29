import { percentOf } from "./calculator.js";

// The report generator divides the share of a category by the total for that
// category. On the first day of a new category the total is zero.
const rows = [
  { category: "widgets", total: 12, part: 3 },
  { category: "gadgets", total: 0, part: 0 },
];

for (const row of rows) {
  const share = percentOf(row.total, row.part);
  if (!Number.isFinite(share)) {
    throw new Error("share for " + row.category + " is not a finite number: " + share);
  }
  console.log(row.category + " -> " + share.toFixed(1) + "%");
}

console.log("report complete");
