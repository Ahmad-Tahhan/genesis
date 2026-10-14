import { describe, expect, it } from 'vitest';
import { PART_FLOATS, SNAP_HEADER, creatureSnapshotSize } from '../src/shared/protocol';
import { decodeCreatureSnapshot } from '../src/render/creatures';

/** Build a snapshot buffer by hand for the given creatures. */
function buildSnapshot(creatures: { id: number; parts: number }[]): Float32Array {
  const data = new Float32Array(creatureSnapshotSize(creatures.map((c) => c.parts)));
  data[0] = 1.25; // time
  data[1] = creatures.length;
  data[2] = 0.5; // sun angle
  data[3] = 0.25; // season phase
  let off = SNAP_HEADER;
  for (const c of creatures) {
    data[off++] = c.id;
    data[off++] = c.parts;
    for (let p = 0; p < c.parts; p++) {
      // Recognizable per-part pose: px = 100*id + p, quaternion w = 1.
      const b = off + p * PART_FLOATS;
      data[b] = 100 * c.id + p;
      data[b + 1] = 2;
      data[b + 2] = 3;
      data[b + 6] = 1;
    }
    off += c.parts * PART_FLOATS;
  }
  return data;
}

describe('creature snapshot decoding (protocol layout)', () => {
  it('visits every creature at the correct buffer offsets', () => {
    const data = buildSnapshot([
      { id: 7, parts: 2 },
      { id: 9, parts: 1 },
    ]);
    const seen: [number, number, number][] = [];
    const visited = decodeCreatureSnapshot(data, (id, parts, first) =>
      seen.push([id, parts, first]),
    );

    expect(visited).toBe(2);
    expect(seen[0]).toEqual([7, 2, SNAP_HEADER + 2]);
    expect(seen[1]).toEqual([9, 1, SNAP_HEADER + 2 + 2 * PART_FLOATS + 2]);

    // The offsets really point at the poses written for those creatures.
    const [, , first7] = seen[0];
    expect(data[first7]).toBe(700); // creature 7, part 0 px
    expect(data[first7 + PART_FLOATS]).toBe(701); // creature 7, part 1 px
    expect(data[first7 + PART_FLOATS + 6]).toBe(1); // qw
    const [, , first9] = seen[1];
    expect(data[first9]).toBe(900); // creature 9, part 0 px
  });

  it('matches creatureSnapshotSize exactly (no trailing floats)', () => {
    const data = buildSnapshot([{ id: 3, parts: 5 }]);
    let endOffset = 0;
    decodeCreatureSnapshot(data, (_id, parts, first) => {
      endOffset = first + parts * PART_FLOATS;
    });
    expect(endOffset).toBe(data.length);
    expect(data.length).toBe(creatureSnapshotSize([5]));
  });

  it('stops cleanly on truncated buffers', () => {
    const full = buildSnapshot([
      { id: 1, parts: 3 },
      { id: 2, parts: 2 },
    ]);
    // Cut the buffer in the middle of creature 2's parts.
    const truncated = full.subarray(0, SNAP_HEADER + 2 + 3 * PART_FLOATS + 2 + PART_FLOATS);
    const ids: number[] = [];
    const visited = decodeCreatureSnapshot(truncated, (id) => ids.push(id));
    expect(visited).toBe(1);
    expect(ids).toEqual([1]);
  });

  it('handles an empty world and a header-only buffer', () => {
    expect(decodeCreatureSnapshot(buildSnapshot([]), () => undefined)).toBe(0);
    expect(decodeCreatureSnapshot(new Float32Array(2), () => undefined)).toBe(0);
  });
});
