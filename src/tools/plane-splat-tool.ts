import { Button, Container, Label } from '@playcanvas/pcui';
import { Transform as SourceTransform } from '@playcanvas/splat-transform';
import type { ChunkLayer, ChunkSource, ChunkSourceMetadata, ReadRequest } from '@playcanvas/splat-transform';
import { Quat, Vec3 } from 'playcanvas';

import type { CommandContext } from '../command-queue';
import { AddSplatOp } from '../edit-ops';
import { EditorSplatResource } from '../editor-splat-resource';
import type { Events } from '../events';
import type { GridPlane } from '../infinite-grid';
import type { Scene } from '../scene';
import { Splat } from '../splat';
import { i18n } from '../ui/localization';

const SH_C0 = 0.28209479177387814;
// Match black_patch_10mx10m.ply: a 2.5 cm center grid in two layers,
// separated by 1 mm, with flat 2.5 cm x 2.5 cm x 1 mm gaussians.
const GRID_SPACING = 0.025;
const NORMAL_SCALE = 0.001;
const LAYER_OFFSETS = [-0.0005, 0.0005] as const;
const OPACITY_LOGIT = Math.log(0.9 / 0.1);
const MAX_GAUSSIANS = 2_000_000;
const MIN_DRAG_PIXELS = 4;

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

// A small retained ChunkSource keeps generated layers on the same load/edit/export
// path as imported splats. Only positions vary; every gaussian uses the
// reference patch's flat geometry and opacity with a magenta DC color.
class PlaneSplatSource implements ChunkSource {
    readonly meta: ChunkSourceMetadata;

    constructor(
        private readonly positions: Float32Array,
        private readonly scales: readonly [number, number, number],
        private readonly rotation: readonly [number, number, number, number]
    ) {
        const count = positions.length / 3;
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
            for (let i = 0; i < count; ++i) {
                const src = sourceRow(i) * 3;
                const out = i * stride;
                dst[out] = this.positions[src];
                dst[out + 1] = this.positions[src + 1];
                dst[out + 2] = this.positions[src + 2];
            }
        }

        if (request.geometric) {
            const dst = new Float32Array(request.geometric.data);
            const stride = request.geometric.stride / 4;
            const scaleX = Math.log(this.scales[0]);
            const scaleY = Math.log(this.scales[1]);
            const scaleZ = Math.log(this.scales[2]);
            for (let i = 0; i < count; ++i) {
                const out = i * stride;
                dst[out] = this.rotation[0];
                dst[out + 1] = this.rotation[1];
                dst[out + 2] = this.rotation[2];
                dst[out + 3] = this.rotation[3];
                dst[out + 4] = scaleX;
                dst[out + 5] = scaleY;
                dst[out + 6] = scaleZ;
                dst[out + 7] = OPACITY_LOGIT;
            }
        }

        if (request.color) {
            const dst = new Float32Array(request.color.data);
            const stride = request.color.stride / 4;
            const high = 0.5 / SH_C0;
            const low = -0.5 / SH_C0;
            for (let i = 0; i < count; ++i) {
                const out = i * stride;
                dst[out] = high;
                dst[out + 1] = low;
                dst[out + 2] = high;
            }
        }
    }

    async close() {
        // The typed array is owned by this source and released with it.
    }
}

type Point2 = { x: number; y: number };
type ResizeCorner = 'nw' | 'ne' | 'se' | 'sw';

const planeAxes: Record<GridPlane, { normal: 'x' | 'y' | 'z'; u: 'x' | 'y' | 'z'; v: 'x' | 'y' | 'z' }> = {
    xy: { normal: 'z', u: 'x', v: 'y' },
    xz: { normal: 'y', u: 'x', v: 'z' },
    yz: { normal: 'x', u: 'y', v: 'z' }
};

type Frame = {
    u: readonly [number, number, number];
    v: readonly [number, number, number];
    normal: readonly [number, number, number];
    rotation: readonly [number, number, number, number];
};

// Equivalent to generate_gaussian_patch.py make_frame() with roll=0 for the
// positive axis normal of each supported plane. Rotation is scalar-first wxyz.
const SQRT_HALF = Math.SQRT1_2;
const planeFrames: Record<GridPlane, Frame> = {
    xy: { u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], rotation: [1, 0, 0, 0] },
    xz: { u: [1, 0, 0], v: [0, 0, -1], normal: [0, 1, 0], rotation: [SQRT_HALF, -SQRT_HALF, 0, 0] },
    yz: { u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0], rotation: [0.5, 0.5, 0.5, 0.5] }
};

const alignments: Record<GridPlane, { azim: number; elev: number }> = {
    xy: { azim: 0, elev: -90 },
    xz: { azim: 180, elev: 0 },
    yz: { azim: 90, elev: 0 }
};

class PlaneSplatTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'plane-splat-svg';
        parent.appendChild(svg);

        const rect = document.createElementNS(svg.namespaceURI, 'rect') as SVGRectElement;
        svg.appendChild(rect);

        const handles = new Map<ResizeCorner, SVGCircleElement>();
        for (const corner of ['nw', 'ne', 'se', 'sw'] as const) {
            const handle = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
            handle.classList.add('plane-splat-handle', `plane-splat-handle-${corner}`);
            handle.dataset.corner = corner;
            handle.setAttribute('r', '6');
            svg.appendChild(handle);
            handles.set(corner, handle);
        }

        const drawHint = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(drawHint, 'plane-splat.hint');
        const adjustHint = new Label({ class: 'select-toolbar-label', hidden: true });
        i18n.bindText(adjustHint, 'plane-splat.adjust-hint');
        const cancelButton = new Button({ class: 'select-toolbar-button', hidden: true });
        i18n.bindText(cancelButton, 'popup.cancel');
        const confirmButton = new Button({ class: 'select-toolbar-button', hidden: true });
        i18n.bindText(confirmButton, 'popup.ok');
        const toolbar = new Container({ class: ['select-toolbar', 'select-toolbar-tool'], hidden: true });
        toolbar.dom.addEventListener('pointerdown', (event) => event.stopPropagation());
        toolbar.append(drawHint);
        toolbar.append(adjustHint);
        toolbar.append(cancelButton);
        toolbar.append(confirmButton);
        canvasContainer.append(toolbar);

        let plane: GridPlane = 'xy';
        let active = false;
        let creating = false;
        let previewing = false;
        let resizing = false;
        let dragId: number | undefined;
        const start: Point2 = { x: 0, y: 0 };
        const end: Point2 = { x: 0, y: 0 };
        const resizeOriginalStart: Point2 = { x: 0, y: 0 };
        const resizeOriginalEnd: Point2 = { x: 0, y: 0 };
        let previousGrid: { visible: boolean; planes: GridPlane[] } | null = null;

        const updateRect = () => {
            const minX = Math.min(start.x, end.x);
            const minY = Math.min(start.y, end.y);
            const maxX = Math.max(start.x, end.x);
            const maxY = Math.max(start.y, end.y);
            rect.setAttribute('x', String(minX));
            rect.setAttribute('y', String(minY));
            rect.setAttribute('width', String(maxX - minX));
            rect.setAttribute('height', String(maxY - minY));
            const positions: Record<ResizeCorner, Point2> = {
                nw: { x: minX, y: minY },
                ne: { x: maxX, y: minY },
                se: { x: maxX, y: maxY },
                sw: { x: minX, y: maxY }
            };
            for (const [corner, handle] of handles) {
                handle.setAttribute('cx', String(positions[corner].x));
                handle.setAttribute('cy', String(positions[corner].y));
            }
        };

        const setPreviewing = (value: boolean) => {
            previewing = value;
            drawHint.hidden = value;
            adjustHint.hidden = !value;
            cancelButton.hidden = !value;
            confirmButton.hidden = !value;
            svg.classList.toggle('plane-splat-preview', value);
            for (const handle of handles.values()) handle.classList.toggle('hidden', !value);
        };

        const pointerPosition = (event: PointerEvent): Point2 => {
            const bounds = parent.getBoundingClientRect();
            return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        };

        const hasUsableSize = () =>
            Math.abs(end.x - start.x) >= MIN_DRAG_PIXELS && Math.abs(end.y - start.y) >= MIN_DRAG_PIXELS;

        const configureView = () => {
            const { normal } = planeAxes[plane];
            const focalPoint = scene.camera.focalPoint;
            focalPoint[normal] = 0;
            scene.camera.setFocalPoint(focalPoint, 0);
            scene.camera.setAzimElev(alignments[plane].azim, alignments[plane].elev, 0);
            scene.camera.ortho = true;
            events.fire('grid.setVisible', true);
            events.fire('grid.setPlanes', [plane]);
            scene.forceRender = true;
        };

        const pointOnPlane = (point: Point2) => {
            const camera = scene.camera.camera;
            const near = camera.screenToWorld(point.x, point.y, camera.nearClip, new Vec3());
            const far = camera.screenToWorld(point.x, point.y, camera.farClip, new Vec3());
            const direction = far.sub(near);
            const axis = planeAxes[plane].normal;
            const denominator = direction[axis];
            if (Math.abs(denominator) < 1e-8) return null;
            return near.add(direction.mulScalar(-near[axis] / denominator));
        };

        const buildPositions = (a: Vec3, b: Vec3) => {
            const { normal, u, v } = planeAxes[plane];
            const minU = Math.min(a[u], b[u]);
            const maxU = Math.max(a[u], b[u]);
            const minV = Math.min(a[v], b[v]);
            const maxV = Math.max(a[v], b[v]);
            const width = maxU - minU;
            const height = maxV - minV;
            if (!(width > 0) || !(height > 0)) return null;

            const columns = Math.ceil(width / GRID_SPACING) + 1;
            const rows = Math.ceil(height / GRID_SPACING) + 1;
            const layerCount = LAYER_OFFSETS.length;
            const count = columns * rows * layerCount;
            if (count > MAX_GAUSSIANS) {
                throw new Error(
                    `${count.toLocaleString()} Gaussians exceeds the ${MAX_GAUSSIANS.toLocaleString()} limit`
                );
            }

            const stepU = width / (columns - 1);
            const stepV = height / (rows - 1);
            const positions = new Float32Array(count * 3);
            const center = a.clone().add(b).mulScalar(0.5);
            center[normal] = 0;
            const frame = planeFrames[plane];
            let dst = 0;
            for (const layerOffset of LAYER_OFFSETS) {
                for (let row = 0; row < rows; ++row) {
                    const offsetV = -height * 0.5 + row * stepV;
                    for (let column = 0; column < columns; ++column) {
                        const offsetU = -width * 0.5 + column * stepU;
                        positions[dst++] =
                            center.x + offsetU * frame.u[0] + offsetV * frame.v[0] + layerOffset * frame.normal[0];
                        positions[dst++] =
                            center.y + offsetU * frame.u[1] + offsetV * frame.v[1] + layerOffset * frame.normal[1];
                        positions[dst++] =
                            center.z + offsetU * frame.u[2] + offsetV * frame.v[2] + layerOffset * frame.normal[2];
                    }
                }
            }

            // The script uses actual endpoint-inclusive spacing for its two
            // in-plane standard deviations (sigma-ratio=1), not the requested
            // maximum spacing when the size is not an exact multiple of it.
            const scales: [number, number, number] = [stepU, stepV, NORMAL_SCALE];
            return { positions, scales, rotation: frame.rotation };
        };

        const createSplat = async (a: Vec3, b: Vec3) => {
            let source: PlaneSplatSource | null = null;
            let splat: Splat | null = null;
            try {
                const generated = buildPositions(a, b);
                if (!generated) return;

                source = new PlaneSplatSource(generated.positions, generated.scales, generated.rotation);
                const resource = await EditorSplatResource.create(scene.graphicsDevice, source);
                const filename = `${plane.toUpperCase()} Magenta Plane.splat`;
                const asset = scene.assetLoader.createGSplatAsset(resource, filename);
                splat = new Splat(asset, Quat.IDENTITY);
                await events.invoke<Promise<void>>('queue', (ctx: CommandContext) =>
                    ctx.apply(new AddSplatOp(scene, splat))
                );
            } catch (error) {
                splat?.destroy();
                await source?.close();
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: `${i18n.t('plane-splat.error')} ${error instanceof Error ? error.message : String(error)}`
                });
            }
        };

        const finishDrag = (keepVisible = false) => {
            if (dragId !== undefined && parent.hasPointerCapture(dragId)) {
                parent.releasePointerCapture(dragId);
            }
            dragId = undefined;
            resizing = false;
            if (!keepVisible) svg.classList.add('hidden');
        };

        const resetPreview = () => {
            finishDrag();
            setPreviewing(false);
        };

        const cancel = () => {
            if (!active || creating) return;
            resetPreview();
            events.fire('tool.deactivate');
        };

        const confirm = async () => {
            if (!active || !previewing || creating || !hasUsableSize()) return;
            const a = pointOnPlane(start);
            const b = pointOnPlane(end);
            if (!a || !b) return;

            creating = true;
            cancelButton.enabled = false;
            confirmButton.enabled = false;
            try {
                await createSplat(a, b);
            } finally {
                creating = false;
                cancelButton.enabled = true;
                confirmButton.enabled = true;
                events.fire('tool.deactivate');
            }
        };

        const pointerdown = (event: PointerEvent) => {
            if (
                creating ||
                dragId !== undefined ||
                (event.pointerType === 'mouse' ? event.button !== 0 : !event.isPrimary)
            ) {
                return;
            }

            if (previewing) {
                const corner = (event.target as SVGElement | null)?.dataset?.corner as ResizeCorner | undefined;
                if (!corner || !handles.has(corner)) return;

                const minX = Math.min(start.x, end.x);
                const minY = Math.min(start.y, end.y);
                const maxX = Math.max(start.x, end.x);
                const maxY = Math.max(start.y, end.y);
                const corners: Record<ResizeCorner, { point: Point2; opposite: Point2 }> = {
                    nw: { point: { x: minX, y: minY }, opposite: { x: maxX, y: maxY } },
                    ne: { point: { x: maxX, y: minY }, opposite: { x: minX, y: maxY } },
                    se: { point: { x: maxX, y: maxY }, opposite: { x: minX, y: minY } },
                    sw: { point: { x: minX, y: maxY }, opposite: { x: maxX, y: minY } }
                };
                resizeOriginalStart.x = start.x;
                resizeOriginalStart.y = start.y;
                resizeOriginalEnd.x = end.x;
                resizeOriginalEnd.y = end.y;
                start.x = corners[corner].opposite.x;
                start.y = corners[corner].opposite.y;
                end.x = corners[corner].point.x;
                end.y = corners[corner].point.y;
                resizing = true;
            }

            event.preventDefault();
            event.stopPropagation();
            dragId = event.pointerId;
            if (!resizing) {
                const point = pointerPosition(event);
                start.x = end.x = point.x;
                start.y = end.y = point.y;
            }
            parent.setPointerCapture(dragId);
            updateRect();
            svg.classList.remove('hidden');
        };

        const pointermove = (event: PointerEvent) => {
            if (event.pointerId !== dragId) return;
            event.preventDefault();
            event.stopPropagation();
            const point = pointerPosition(event);
            end.x = point.x;
            end.y = point.y;
            updateRect();
        };

        const pointerup = (event: PointerEvent) => {
            if (event.pointerId !== dragId) return;
            event.preventDefault();
            event.stopPropagation();
            const point = pointerPosition(event);
            end.x = point.x;
            end.y = point.y;
            updateRect();

            if (resizing) {
                if (!hasUsableSize()) {
                    start.x = resizeOriginalStart.x;
                    start.y = resizeOriginalStart.y;
                    end.x = resizeOriginalEnd.x;
                    end.y = resizeOriginalEnd.y;
                    updateRect();
                }
                finishDrag(true);
                return;
            }

            if (!hasUsableSize()) {
                finishDrag();
                return;
            }
            finishDrag(true);
            setPreviewing(true);
        };

        const pointercancel = (event: PointerEvent) => {
            if (event.pointerId !== dragId) return;
            if (resizing) {
                start.x = resizeOriginalStart.x;
                start.y = resizeOriginalStart.y;
                end.x = resizeOriginalEnd.x;
                end.y = resizeOriginalEnd.y;
                updateRect();
                finishDrag(true);
            } else {
                finishDrag();
            }
        };

        const keydown = (event: KeyboardEvent) => {
            if (!active || creating) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancel();
            } else if (event.key === 'Enter' && previewing) {
                event.preventDefault();
                event.stopPropagation();
                void confirm();
            }
        };

        cancelButton.on('click', cancel);
        confirmButton.on('click', () => void confirm());

        events.on('planeSplat.setPlane', (value: GridPlane) => {
            if (!planeAxes[value]) return;
            if (active && value !== plane) resetPreview();
            plane = value;
            events.fire('planeSplat.plane', plane);
            if (active) configureView();
        });

        this.activate = () => {
            active = true;
            resetPreview();
            previousGrid = {
                visible: events.invoke('grid.visible'),
                planes: events.invoke<GridPlane[]>('grid.planes')
            };
            configureView();
            parent.style.display = 'block';
            toolbar.hidden = false;
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
            window.addEventListener('keydown', keydown, true);
        };

        this.deactivate = () => {
            active = false;
            resetPreview();
            parent.style.display = 'none';
            toolbar.hidden = true;
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('pointercancel', pointercancel);
            window.removeEventListener('keydown', keydown, true);
            if (previousGrid) {
                events.fire('grid.setVisible', previousGrid.visible);
                events.fire('grid.setPlanes', previousGrid.planes);
                previousGrid = null;
            }
        };
    }
}

export { PlaneSplatTool };
