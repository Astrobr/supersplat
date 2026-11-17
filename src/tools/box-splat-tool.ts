import { Button, Container, Label, VectorInput } from '@playcanvas/pcui';
import { Quat, Vec3 } from 'playcanvas';

import { BoxShape } from '../box-shape';
import type { CommandContext } from '../command-queue';
import { AddSplatOp } from '../edit-ops';
import { EditorSplatResource } from '../editor-splat-resource';
import type { Events } from '../events';
import type { Scene } from '../scene';
import { Splat } from '../splat';
import { i18n } from '../ui/localization';

import { buildBoxSplatGeometry } from './box-splat-geometry';
import { BoxSplatSource } from './box-splat-source';
import { ShapeTransformGizmo } from './shape-transform-gizmo';
import type { ShapeGizmoMode } from './shape-transform-gizmo';

class BoxSplatTool {
    activate: () => void;
    deactivate: () => void;
    setTransformMode: (mode: Exclude<ShapeGizmoMode, 'none'>) => boolean;
    getFocus: () => { position: Vec3; radius: number } | null;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const box = new BoxShape();
        const toolbar = new Container({ class: 'select-toolbar', hidden: true });
        toolbar.dom.addEventListener('pointerdown', (event) => event.stopPropagation());

        const translateButton = new Button({ class: 'select-toolbar-mode', icon: 'E111' });
        const rotateButton = new Button({ class: 'select-toolbar-mode', icon: 'E113' });
        const scaleButton = new Button({ class: 'select-toolbar-mode', icon: 'E112' });

        const positionLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(positionLabel, 'select-toolbar.position');
        const position = new VectorInput({
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0]
        });

        const sizeLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(sizeLabel, 'select-toolbar.size');
        const size = new VectorInput({
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [2, 2, 2],
            min: 0.01
        });

        const rotationLabel = new Label({ class: 'select-toolbar-label', hidden: true });
        i18n.bindText(rotationLabel, 'select-toolbar.rotation');
        const rotation = new VectorInput({
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            hidden: true
        });

        const cancelButton = new Button({ class: 'select-toolbar-button' });
        i18n.bindText(cancelButton, 'popup.cancel');
        const confirmButton = new Button({ class: 'select-toolbar-button' });
        i18n.bindText(confirmButton, 'popup.ok');

        toolbar.append(translateButton);
        toolbar.append(rotateButton);
        toolbar.append(scaleButton);
        toolbar.append(positionLabel);
        toolbar.append(position);
        toolbar.append(sizeLabel);
        toolbar.append(size);
        toolbar.append(rotationLabel);
        toolbar.append(rotation);
        toolbar.append(cancelButton);
        toolbar.append(confirmButton);
        canvasContainer.append(toolbar);

        let active = false;
        let creating = false;
        let uiUpdating = false;

        const updateUI = () => {
            uiUpdating = true;
            const p = box.pivot.getPosition();
            position.value = [p.x, p.y, p.z];
            size.value = [box.lenX, box.lenY, box.lenZ];
            const e = box.pivot.getLocalEulerAngles();
            rotation.value = [e.x, e.y, e.z];
            uiUpdating = false;
        };

        const syncModeUI = (mode: ShapeGizmoMode) => {
            translateButton.class[mode === 'translate' ? 'add' : 'remove']('active');
            rotateButton.class[mode === 'rotate' ? 'add' : 'remove']('active');
            scaleButton.class[mode === 'scale' ? 'add' : 'remove']('active');
            const rotating = mode === 'rotate';
            sizeLabel.hidden = rotating;
            size.hidden = rotating;
            rotationLabel.hidden = !rotating;
            rotation.hidden = !rotating;
        };

        const gizmo = new ShapeTransformGizmo(events, scene, {
            rotate: true,
            uniformScale: false,
            lowerBoundScale: new Vec3(0.01, 0.01, 0.01),
            onTransformStart: () => undefined,
            onTransform: (mode) => {
                if (mode === 'scale') {
                    const { x, y, z } = box.pivot.getLocalScale();
                    box.lenX = x;
                    box.lenY = y;
                    box.lenZ = z;
                } else {
                    box.moved();
                }
                updateUI();
            },
            onTransformEnd: () => undefined,
            onModeChanged: syncModeUI
        });
        syncModeUI(gizmo.mode);

        this.setTransformMode = (mode) => {
            gizmo.toggleMode(mode);
            return true;
        };

        translateButton.on('click', () => gizmo.toggleMode('translate'));
        rotateButton.on('click', () => gizmo.toggleMode('rotate'));
        scaleButton.on('click', () => gizmo.toggleMode('scale'));

        position.on('change', (value: number[]) => {
            if (uiUpdating) return;
            box.pivot.setPosition(value[0], value[1], value[2]);
            box.moved();
            gizmo.attach(box.pivot);
        });
        size.on('change', (value: number[]) => {
            if (uiUpdating) return;
            box.lenX = value[0];
            box.lenY = value[1];
            box.lenZ = value[2];
        });
        rotation.on('change', (value: number[]) => {
            if (uiUpdating) return;
            box.pivot.setLocalEulerAngles(value[0], value[1], value[2]);
            box.moved();
            gizmo.attach(box.pivot);
        });

        const confirm = async () => {
            if (!active || creating) return;
            const center = box.pivot.getPosition().clone();
            const orientation = box.pivot.getRotation().clone();
            const dimensions: [number, number, number] = [box.lenX, box.lenY, box.lenZ];
            creating = true;
            confirmButton.enabled = false;
            cancelButton.enabled = false;
            gizmo.detach();
            let source: BoxSplatSource | null = null;
            let splat: Splat | null = null;
            try {
                source = new BoxSplatSource(buildBoxSplatGeometry(dimensions));
                const resource = await EditorSplatResource.create(scene.graphicsDevice, source);
                const asset = scene.assetLoader.createGSplatAsset(resource, 'Magenta Box.splat');
                splat = new Splat(asset, Quat.IDENTITY);
                splat.entity.setLocalPosition(center);
                splat.entity.setLocalRotation(orientation);
                await events.invoke<Promise<void>>('queue', (ctx: CommandContext) =>
                    ctx.apply(new AddSplatOp(scene, splat))
                );
            } catch (error) {
                splat?.destroy();
                await source?.close();
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: `${i18n.t('box-splat.error')} ${error instanceof Error ? error.message : String(error)}`
                });
            } finally {
                creating = false;
                confirmButton.enabled = true;
                cancelButton.enabled = true;
                if (active) events.fire('tool.deactivate');
            }
        };

        const cancel = () => {
            if (active && !creating) events.fire('tool.deactivate');
        };
        confirmButton.on('click', () => void confirm());
        cancelButton.on('click', cancel);

        const keydown = (event: KeyboardEvent) => {
            if (!active || creating) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
            } else if (event.key === 'Enter' && !(event.target instanceof HTMLInputElement)) {
                event.preventDefault();
                void confirm();
            }
        };

        this.getFocus = () => {
            const bound = box.worldBound;
            return { position: bound.center.clone(), radius: bound.halfExtents.length() };
        };

        this.activate = () => {
            active = true;
            box.pivot.setPosition(0, 0, 0);
            box.pivot.setLocalRotation(Quat.IDENTITY);
            box.lenX = 2;
            box.lenY = 2;
            box.lenZ = 2;
            scene.add(box);
            gizmo.setMode('translate');
            gizmo.attach(box.pivot);
            updateUI();
            toolbar.hidden = false;
            window.addEventListener('keydown', keydown, true);
        };

        this.deactivate = () => {
            active = false;
            window.removeEventListener('keydown', keydown, true);
            toolbar.hidden = true;
            gizmo.detach();
            scene.remove(box);
        };
    }
}

export { BoxSplatTool };
