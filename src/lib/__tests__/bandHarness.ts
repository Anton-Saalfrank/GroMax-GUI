/**
 * Harness: run the frontend's error band on stdin JSON, print the result.
 *
 * Exists so backend/tests/test_band_consistency.py can compare the band the
 * Results tab plots (computed in Python) against the one the Compare tab draws
 * (computed here) on identical input. Asserting in two places that both "use
 * n-1" would not catch a divergence in rounding, truncation or NaN handling;
 * running both and diffing the numbers does.
 */
import { recomputeMean } from '../stats'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  const input = JSON.parse(raw) as { replicas: { y: number[] }[] }
  const { mean, sd } = recomputeMean(input.replicas)
  process.stdout.write(JSON.stringify({ mean, sd }))
})
