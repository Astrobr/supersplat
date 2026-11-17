const GRID_SPACING = 0.025;
const NORMAL_SCALE = 0.001;
const LAYER_OFFSETS = [-0.0005, 0.0005] as const;
const MAX_GAUSSIANS = 2_000_000;

type BoxFace = {
    offset: number;
    count: number;
    scales: readonly [number, number, number];
    rotation: readonly [number, number, number, number];
};

type BoxSplatGeometry = { positions: Float32Array; faces: BoxFace[] };

// Each pair of opposite faces uses the same two-sided, two-layer Gaussian
// orientation as the magenta plane tool. Only the six surfaces are populated.
const frames = [
    { normal: 2, u: 0, v: 1, vSign: 1, rotation: [1, 0, 0, 0] },
    { normal: 1, u: 0, v: 2, vSign: -1, rotation: [Math.SQRT1_2, -Math.SQRT1_2, 0, 0] },
    { normal: 0, u: 1, v: 2, vSign: 1, rotation: [0.5, 0.5, 0.5, 0.5] }
] as const;

const buildBoxSplatGeometry = (size: readonly [number, number, number]): BoxSplatGeometry => {
    if (!size.every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error('Box dimensions must be positive finite numbers');
    }

    const specs = frames.flatMap((frame) => {
        const columns = Math.ceil(size[frame.u] / GRID_SPACING) + 1;
        const rows = Math.ceil(size[frame.v] / GRID_SPACING) + 1;
        return [-1, 1].map((side) => ({ frame, columns, rows, side, count: columns * rows * LAYER_OFFSETS.length }));
    });
    const count = specs.reduce((total, spec) => total + spec.count, 0);
    if (!Number.isSafeInteger(count) || count > MAX_GAUSSIANS) {
        throw new Error(`Box exceeds the ${MAX_GAUSSIANS.toLocaleString()} Gaussian limit`);
    }

    const positions = new Float32Array(count * 3);
    const faces: BoxFace[] = [];
    let index = 0;
    for (const spec of specs) {
        const { frame, columns, rows, side } = spec;
        const stepU = size[frame.u] / (columns - 1);
        const stepV = size[frame.v] / (rows - 1);
        faces.push({
            offset: index,
            count: spec.count,
            scales: [stepU, stepV, NORMAL_SCALE],
            rotation: frame.rotation
        });
        for (const layerOffset of LAYER_OFFSETS) {
            for (let row = 0; row < rows; row++) {
                for (let column = 0; column < columns; column++) {
                    const point = [0, 0, 0];
                    point[frame.normal] = side * size[frame.normal] * 0.5 + layerOffset;
                    point[frame.u] = -size[frame.u] * 0.5 + column * stepU;
                    point[frame.v] = frame.vSign * (-size[frame.v] * 0.5 + row * stepV);
                    positions.set(point, index++ * 3);
                }
            }
        }
    }
    return { positions, faces };
};

export { buildBoxSplatGeometry };
export type { BoxFace, BoxSplatGeometry };
