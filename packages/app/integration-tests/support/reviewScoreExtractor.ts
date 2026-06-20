export function extractReviewScore(output: string): number | null {
  // Rating format: "PASS 8/10" or "FAIL 4/10"
  const ratingMatch = output.match(/(?:PASS|FAIL)\s+(\d+)\/10/);
  if (ratingMatch && ratingMatch[1]) {
    return parseInt(ratingMatch[1], 10);
  }

  return null;
}
