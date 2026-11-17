import { Transform as SourceTransform } from '@playcanvas/splat-transform';
import type { ChunkLayer, ChunkSource, ChunkSourceMetadata, ReadRequest } from '@playcanvas/splat-transform';

import type { BoxSplatGeometry } from './box-splat-geometry';

const SH_C0 = 0.28209479177387814;
const OPACITY_LOGIT = Math.log(0.9 / 0.1);

const layouts = {
    position: {
        stride: 12,
        fields: { position: { byteOffset: 0, components: 3, type: 'float32' as const } }
    },
    geometric: {
        stride: 32,
        fields: {
            rotation: { byteOffset: 0, components: 4, type: 'float32' as const },
            scale: { byteOffset: 16, components: 3, type: 'float32' as const },
            opacity: { byteOffset: 28, components: 1, type: 'float32' as const }
        }
    },
    color: {
        stride: 12,
        fields: { dc: { byteOffset: 0, components: 3, type: 'float32' as const } }
    }
};

class BoxSplatSource implements ChunkSource {
    readonly meta: ChunkSourceMetadata;

    constructor(private readonly geometry: BoxSplatGeometry) {
        const count = geometry.positions.length / 3;
        this.meta = {
            numGaussians: count,
            numLods: 1,
            lodCounts: [count],
            chunkSize: Math.max(1, count),
            numChunks: [count > 0 ? 1 : 0],
            shBands: 0,
            model: 'default',
            extraColumns: [],
            transform: new SourceTransform(),
            availableLayers: new Set<ChunkLayer>(['position', 'geometric', 'color']),
            layouts
        };
    }

    async read(request: ReadRequest) {
        const count =
            'indices' in request
                ? request.count
                : (request.position?.count ?? request.geometric?.count ?? request.color?.count ?? 0);
        const first = 'indices' in request ? request.indexOffset : request.chunkIndex * this.meta.chunkSize;
        const sourceRow = (row: number) => ('indices' in request ? request.indices[first + row] : first + row);

        if (request.position) {
            const dst = new Float32Array(request.position.data);
            const stride = request.position.stride / 4;
            for (let i = 0; i < count; i++) {
                const src = sourceRow(i) * 3;
                const out = i * stride;
                dst[out] = this.geometry.positions[src];
                dst[out + 1] = this.geometry.positions[src + 1];
                dst[out + 2] = this.geometry.positions[src + 2];
            }
        }

        if (request.geometric) {
            const dst = new Float32Array(request.geometric.data);
            const stride = request.geometric.stride / 4;
            for (let i = 0; i < count; i++) {
                const row = sourceRow(i);
                const face = this.geometry.faces.find(({ offset, count }) => row >= offset && row < offset + count);
                if (!face) throw new Error(`Missing box face for Gaussian ${row}`);
                const out = i * stride;
                dst[out] = face.rotation[0];
                dst[out + 1] = face.rotation[1];
                dst[out + 2] = face.rotation[2];
                dst[out + 3] = face.rotation[3];
                dst[out + 4] = Math.log(face.scales[0]);
                dst[out + 5] = Math.log(face.scales[1]);
                dst[out + 6] = Math.log(face.scales[2]);
                dst[out + 7] = OPACITY_LOGIT;
            }
        }

        if (request.color) {
            const dst = new Float32Array(request.color.data);
            const stride = request.color.stride / 4;
            const high = 0.5 / SH_C0;
            const low = -0.5 / SH_C0;
            for (let i = 0; i < count; i++) {
                const out = i * stride;
                dst[out] = high;
                dst[out + 1] = low;
                dst[out + 2] = high;
            }
        }
    }

    async close() {
        // Geometry is owned by this source and released with it.
    }
}

export { BoxSplatSource };
