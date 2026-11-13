import { along, fractionOf, meters } from './road'

const path: [number, number][] = [[15.86, 74.50], [15.86, 74.51], [15.87, 74.51]]   // east, then north

test('along() walks the road by length and reports the heading of the current segment', () => {
  expect(along(path, 0).p).toEqual(path[0])
  expect(along(path, 1).p).toEqual(path[2])
  const half = meters(path[0], path[1]) / (meters(path[0], path[1]) + meters(path[1], path[2]))
  expect(along(path, half / 2).heading).toBeCloseTo(90, 0)      // first leg heads east
  expect(along(path, (1 + half) / 2).heading).toBeCloseTo(0, 0)  // second leg heads north
})

test('fractionOf() snaps a nearby GPS point onto the road', () => {
  expect(fractionOf(path, [15.8601, 74.50])).toBeCloseTo(0, 2)
  expect(fractionOf(path, [15.87, 74.5101])).toBeCloseTo(1, 2)
  const f = fractionOf(path, [15.8605, 74.505])
  expect(f).toBeGreaterThan(0.2); expect(f).toBeLessThan(0.3)
})
