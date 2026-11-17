import assert from 'node:assert/strict';

import { buildBoxSplatGeometry } from './.build/src/tools/box-splat-geometry.js';

const geometry = buildBoxSplatGeometry([2, 3, 4]);
assert.equal(geometry.faces.length, 6);
assert.equal(geometry.positions.length / 3, geometry.faces.reduce((sum, face) => sum + face.count, 0));
assert.ok(geometry.faces.every((face) => face.count > 0));

const half = [1, 1.5, 2];
for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
        const found = geometry.faces.some((face) => {
            const center = face.offset * 3;
            return Math.abs(geometry.positions[center + axis] - sign * half[axis]) < 0.001;
        });
        assert.ok(found, `missing ${sign > 0 ? '+' : '-'} face on axis ${axis}`);
    }
}

assert.throws(() => buildBoxSplatGeometry([0, 2, 2]), /positive/);
assert.throws(() => buildBoxSplatGeometry([Number.NaN, 2, 2]), /positive/);
assert.throws(() => buildBoxSplatGeometry([100, 100, 100]), /limit/);
console.log('box splat geometry checks passed');
