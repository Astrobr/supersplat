import { ColorPicker, Container, Label, Element as PcuiElement, TextInput } from '@playcanvas/pcui';
import { Color } from 'playcanvas';

import { createGradeTerms } from '../color-grade';
import type { GradeTerms } from '../color-grade';
import { SplatsColorOp, SplatRenameOp } from '../edit-ops';
import type { Element } from '../element';
import { ElementType } from '../element';
import type { Events } from '../events';
import type { Splat } from '../splat';

import { i18n } from './localization';
import deleteSvg from './svg/delete.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';
import type { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

// A zero matrix plus an RGB offset replaces DC and every SH coefficient with a
// constant colour. Stored in the regular per-gaussian colour palette, this is
// rendered by the editor and baked by every model exporter.
const solidGrade = (color: Color): GradeTerms => {
    const grade = createGradeTerms();
    grade.m.fill(0);
    grade.offset.r = color.r;
    grade.offset.g = color.g;
    grade.offset.b = color.b;
    return grade;
};

// Recover the swatch when every gaussian currently carries the same solid
// colour. Original or mixed-colour layers return null and use PCUI's mixed-value
// presentation instead of pretending that they are white.
const solidLayerColor = (splat: Splat): Color | null => {
    const { instances, colorPalette } = splat;
    if (instances.count === 0) return null;

    const grade = createGradeTerms();
    const seen = new Set<number>();
    let result: Color = null;
    for (let i = 0; i < instances.count; ++i) {
        const index = instances.colorIndex(i);
        if (seen.has(index)) continue;
        seen.add(index);
        colorPalette.getEntry(index, grade);
        if (grade.m.some((value) => value !== 0)) return null;

        const color = new Color(grade.offset.r, grade.offset.g, grade.offset.b);
        if (result && !result.equals(color)) return null;
        result = color;
    }
    return result;
};

class SplatItem extends Container {
    getName: () => string;
    setName: (value: string) => void;
    getSelected: () => boolean;
    setSelected: (value: boolean) => void;
    getVisible: () => boolean;
    setVisible: (value: boolean) => void;
    setLayerColor: (value: Color | null) => void;
    setBackgroundColor: (value: Color) => void;
    colorPicker: ColorPicker;
    backgroundColor: PcuiElement;
    destroy: () => void;

    constructor(name: string, edit: TextInput, layerColor: Color | null, backgroundColor: Color, args = {}) {
        args = {
            ...args,
            class: ['splat-item', 'visible']
        };

        super(args);

        const text = new Label({
            class: 'splat-item-text',
            text: name
        });

        const visible = new PcuiElement({
            dom: createSvg(shownSvg),
            class: 'splat-item-visible'
        });

        const invisible = new PcuiElement({
            dom: createSvg(hiddenSvg),
            class: 'splat-item-visible',
            hidden: true
        });

        const remove = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'splat-item-delete'
        });

        const colorPicker = new ColorPicker({
            class: 'splat-item-color',
            channels: 3,
            value: layerColor ? [layerColor.r, layerColor.g, layerColor.b] : [1, 1, 1]
        });

        // This swatch is also a button: it always displays the current viewport
        // background and copies that colour to this layer when clicked.
        const useBackgroundColor = new PcuiElement({
            class: 'splat-item-background-color'
        });
        useBackgroundColor.dom.setAttribute('role', 'button');
        useBackgroundColor.dom.setAttribute('tabindex', '0');

        this.append(text);
        this.append(colorPicker);
        this.append(useBackgroundColor);
        this.append(visible);
        this.append(invisible);
        this.append(remove);

        this.colorPicker = colorPicker;
        this.backgroundColor = useBackgroundColor;

        this.getName = () => {
            return text.value;
        };

        this.setName = (value: string) => {
            text.value = value;
        };

        this.getSelected = () => {
            return this.class.contains('selected');
        };

        this.setSelected = (value: boolean) => {
            if (value !== this.selected) {
                if (value) {
                    this.class.add('selected');
                    this.emit('select', this);
                } else {
                    this.class.remove('selected');
                    this.emit('unselect', this);
                }
            }
        };

        this.getVisible = () => {
            return this.class.contains('visible');
        };

        this.setVisible = (value: boolean) => {
            if (value !== this.visible) {
                visible.hidden = !value;
                invisible.hidden = value;
                if (value) {
                    this.class.add('visible');
                    this.emit('visible', this);
                } else {
                    this.class.remove('visible');
                    this.emit('invisible', this);
                }
            }
        };

        let suppressColorChange = false;
        let colorDirty = false;

        this.setLayerColor = (value: Color | null) => {
            suppressColorChange = true;
            if (value) {
                colorPicker.value = [value.r, value.g, value.b];
            } else {
                colorPicker.value = [1, 1, 1];
                colorPicker.class.add('pcui-multiple-values');
            }
            suppressColorChange = false;
            colorDirty = false;
        };
        this.setLayerColor(layerColor);

        this.setBackgroundColor = (value: Color) => {
            const channel = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
            useBackgroundColor.dom.style.backgroundColor = `rgb(${channel(value.r)}, ${channel(value.g)}, ${channel(value.b)})`;
        };
        this.setBackgroundColor(backgroundColor);

        const toggleVisible = (event: MouseEvent) => {
            event.stopPropagation();
            this.visible = !this.visible;
        };

        const handleRemove = (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('removeClicked', this);
        };

        const applyBackgroundColor = (event: Event) => {
            event.stopPropagation();
            this.emit('useBackgroundColor', this);
        };

        const handleBackgroundKey = (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                applyBackgroundColor(event);
            }
        };

        const handleColorChange = () => {
            if (!suppressColorChange) {
                colorDirty = true;
            }
        };

        const handleColorEnd = () => {
            if (colorDirty) {
                colorDirty = false;
                const value = colorPicker.value;
                this.emit('color', new Color(value[0], value[1], value[2]));
            }
        };

        // rename on double click
        text.dom.addEventListener('dblclick', (event: MouseEvent) => {
            event.stopPropagation();

            const onblur = () => {
                this.remove(edit);
                this.emit('rename', edit.value);
                edit.input.removeEventListener('blur', onblur);
                text.hidden = false;
            };

            text.hidden = true;

            this.appendAfter(edit, text);
            edit.value = text.value;
            edit.input.addEventListener('blur', onblur);
            edit.focus();
        });

        // handle clicks
        visible.dom.addEventListener('click', toggleVisible);
        invisible.dom.addEventListener('click', toggleVisible);
        remove.dom.addEventListener('click', handleRemove);
        useBackgroundColor.dom.addEventListener('click', applyBackgroundColor);
        useBackgroundColor.dom.addEventListener('keydown', handleBackgroundKey);
        colorPicker.on('change', handleColorChange);
        colorPicker.on('picker:color:end', handleColorEnd);

        this.destroy = () => {
            visible.dom.removeEventListener('click', toggleVisible);
            invisible.dom.removeEventListener('click', toggleVisible);
            remove.dom.removeEventListener('click', handleRemove);
            useBackgroundColor.dom.removeEventListener('click', applyBackgroundColor);
            useBackgroundColor.dom.removeEventListener('keydown', handleBackgroundKey);
            colorPicker.unbind('change', handleColorChange);
            colorPicker.unbind('picker:color:end', handleColorEnd);
        };
    }

    set name(value: string) {
        this.setName(value);
    }

    get name() {
        return this.getName();
    }

    set selected(value) {
        this.setSelected(value);
    }

    get selected() {
        return this.getSelected();
    }

    set visible(value) {
        this.setVisible(value);
    }

    get visible() {
        return this.getVisible();
    }
}

class SplatList extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            class: 'splat-list'
        };

        super(args);

        const items = new Map<Splat, SplatItem>();
        let soloMode = false;
        const savedVisibility = new Map<Splat, boolean>();

        // edit input used during renames
        const edit = new TextInput({
            id: 'splat-edit'
        });

        events.on('scene.elementAdded', (element: Element) => {
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = new SplatItem(
                    splat.name,
                    edit,
                    solidLayerColor(splat),
                    events.invoke('bgClr') ?? Color.BLACK
                );
                this.append(item);
                items.set(splat, item);

                tooltips.register(item.colorPicker, () => i18n.t('tooltip.scene.layer-color'), 'top');
                tooltips.register(item.backgroundColor, () => i18n.t('tooltip.scene.use-background-color'), 'top');

                if (soloMode) {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = false;
                }

                item.on('visible', () => {
                    splat.visible = true;

                    // also select it if there is no other selection
                    if (!events.invoke('selection')) {
                        events.fire('selection', splat);
                    }
                });
                item.on('invisible', () => {
                    splat.visible = false;
                });
                item.on('rename', (value: string) => {
                    events.fire('edit.add', new SplatRenameOp(splat, value));
                });
                item.on('color', (value: Color) => {
                    events.fire(
                        'edit.add',
                        new SplatsColorOp({ splat, grade: solidGrade(value), scope: 'layer', includeLocked: true })
                    );
                });
                item.on('useBackgroundColor', () => {
                    events.fire(
                        'edit.add',
                        new SplatsColorOp({
                            splat,
                            grade: solidGrade(events.invoke('bgClr')),
                            scope: 'layer',
                            includeLocked: true
                        })
                    );
                });
            }
        });

        events.on('scene.elementRemoved', (element: Element) => {
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = items.get(splat);
                if (item) {
                    this.remove(item);
                    items.delete(splat);
                }
                savedVisibility.delete(splat);
            }
        });

        events.on('selection.changed', (selection: Splat, prev: Splat) => {
            items.forEach((value, key) => {
                value.selected = key === selection;
            });

            if (soloMode) {
                if (prev) {
                    prev.visible = false;
                }
                if (selection) {
                    selection.visible = true;
                }
            }
        });

        events.on('scene.solo', (value: boolean) => {
            soloMode = value;
            const selection = events.invoke('selection') as Splat;

            if (soloMode) {
                items.forEach((item, splat) => {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = splat === selection;
                });
            } else {
                items.forEach((item, splat) => {
                    const wasVisible = savedVisibility.get(splat);
                    splat.visible = wasVisible !== undefined ? wasVisible : true;
                });
                savedVisibility.clear();
            }
        });

        events.on('splat.name', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.name = splat.name;
            }
        });

        events.on('splat.visibility', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.visible = splat.visible;
            }
        });

        events.on('splat.colorsChanged', (splat: Splat) => {
            items.get(splat)?.setLayerColor(solidLayerColor(splat));
        });

        events.on('bgClr', (color: Color) => {
            items.forEach((item) => item.setBackgroundColor(color));
        });

        this.on('click', (item: SplatItem) => {
            for (const [key, value] of items) {
                if (item === value) {
                    if (soloMode && !key.visible) {
                        key.visible = true;
                    }
                    events.fire('selection', key);
                    break;
                }
            }
        });

        this.on('removeClicked', async (item: SplatItem) => {
            let splat;
            for (const [key, value] of items) {
                if (item === value) {
                    splat = key;
                    break;
                }
            }

            if (!splat) {
                return;
            }

            const result = await events.invoke('showPopup', {
                type: 'yesno',
                header: 'Remove Splat',
                message: `Are you sure you want to remove '${splat.name}' from the scene? This operation can not be undone.`
            });

            if (result?.action === 'yes') {
                splat.destroy();
            }
        });
    }

    protected _onAppendChild(element: PcuiElement): void {
        super._onAppendChild(element);

        if (element instanceof SplatItem) {
            element.on('click', () => {
                this.emit('click', element);
            });

            element.on('removeClicked', () => {
                this.emit('removeClicked', element);
            });
        }
    }

    protected _onRemoveChild(element: PcuiElement): void {
        if (element instanceof SplatItem) {
            element.unbind('click');
            element.unbind('removeClicked');
        }

        super._onRemoveChild(element);
    }
}

export { SplatList, SplatItem };
