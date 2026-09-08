/**
 * Built-in swatch libraries (named hex colours) that can be appended to the
 * document swatches from the Swatches panel.
 */
import type { SwatchKind } from '@/model/types';

export interface SwatchLibrary {
  id: string;
  name: string;
  colors: Array<[string, string]>;
  /** kind of the swatches created from the library (default process) */
  kind?: SwatchKind;
  /** store CMYK values with the swatches (print libraries) */
  cmyk?: boolean;
}

/** Hex of a CMYK colour (naive device conversion). */
function ink(c: number, m: number, y: number, k: number): string {
  const f = (v: number) => Math.round(255 * (1 - v / 100) * (1 - k / 100));
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(f(c))}${h(f(m))}${h(f(y))}`;
}

export const SWATCH_LIBRARIES: SwatchLibrary[] = [
  {
    id: 'print',
    name: 'Print (CMYK)',
    cmyk: true,
    colors: [
      ['C=100 M=0 Y=0 K=0', ink(100, 0, 0, 0)],
      ['C=0 M=100 Y=0 K=0', ink(0, 100, 0, 0)],
      ['C=0 M=0 Y=100 K=0', ink(0, 0, 100, 0)],
      ['C=0 M=0 Y=0 K=100', ink(0, 0, 0, 100)],
      ['Rich Black', ink(60, 40, 40, 100)],
      ['C=100 M=90 Y=10 K=0', ink(100, 90, 10, 0)],
      ['C=85 M=10 Y=100 K=10', ink(85, 10, 100, 10)],
      ['C=0 M=90 Y=85 K=0', ink(0, 90, 85, 0)],
      ['C=0 M=50 Y=100 K=0', ink(0, 50, 100, 0)],
      ['C=75 M=100 Y=0 K=0', ink(75, 100, 0, 0)],
      ['C=0 M=0 Y=0 K=80', ink(0, 0, 0, 80)],
      ['C=0 M=0 Y=0 K=60', ink(0, 0, 0, 60)],
      ['C=0 M=0 Y=0 K=40', ink(0, 0, 0, 40)],
      ['C=0 M=0 Y=0 K=20', ink(0, 0, 0, 20)],
      ['C=0 M=0 Y=0 K=10', ink(0, 0, 0, 10)],
    ],
  },
  {
    id: 'spot',
    name: 'Spot inks (sample)',
    kind: 'spot',
    cmyk: true,
    colors: [
      ['Spot Warm Red', ink(0, 85, 90, 0)],
      ['Spot Process Blue', ink(100, 25, 0, 5)],
      ['Spot Reflex Blue', ink(100, 90, 0, 5)],
      ['Spot Green', ink(90, 0, 75, 0)],
      ['Spot Yellow', ink(0, 5, 100, 0)],
      ['Spot Orange', ink(0, 65, 100, 0)],
      ['Spot Purple', ink(55, 100, 0, 0)],
      ['Spot Rhodamine', ink(5, 90, 0, 0)],
      ['Spot Cool Gray', ink(0, 0, 0, 55)],
      ['Spot Black', ink(0, 0, 0, 100)],
    ],
  },
  {
    id: 'basic',
    name: 'Basic',
    colors: [
      ['White', '#ffffff'],
      ['Black', '#000000'],
      ['Red', '#ff0000'],
      ['Green', '#00ff00'],
      ['Blue', '#0000ff'],
      ['Yellow', '#ffff00'],
      ['Cyan', '#00ffff'],
      ['Magenta', '#ff00ff'],
      ['Orange', '#ff8000'],
      ['Purple', '#8000ff'],
    ],
  },
  {
    id: 'grays',
    name: 'Grays',
    colors: [
      ['Gray 5%', '#f2f2f2'],
      ['Gray 10%', '#e6e6e6'],
      ['Gray 20%', '#cccccc'],
      ['Gray 30%', '#b3b3b3'],
      ['Gray 40%', '#999999'],
      ['Gray 50%', '#808080'],
      ['Gray 60%', '#666666'],
      ['Gray 70%', '#4d4d4d'],
      ['Gray 80%', '#333333'],
      ['Gray 90%', '#1a1a1a'],
    ],
  },
  {
    id: 'websafe',
    name: 'Web safe primaries',
    colors: [
      ['Web Red', '#ff0000'],
      ['Web Maroon', '#990000'],
      ['Web Orange', '#ff9900'],
      ['Web Yellow', '#ffff00'],
      ['Web Olive', '#999900'],
      ['Web Lime', '#99ff00'],
      ['Web Green', '#00cc00'],
      ['Web Teal', '#009999'],
      ['Web Aqua', '#00ffff'],
      ['Web Blue', '#0000ff'],
      ['Web Navy', '#000099'],
      ['Web Purple', '#990099'],
      ['Web Fuchsia', '#ff00ff'],
      ['Web Silver', '#cccccc'],
      ['Web Gray', '#999999'],
    ],
  },
  {
    id: 'material',
    name: 'Material',
    colors: [
      ['Red 500', '#f44336'],
      ['Pink 500', '#e91e63'],
      ['Purple 500', '#9c27b0'],
      ['Deep Purple 500', '#673ab7'],
      ['Indigo 500', '#3f51b5'],
      ['Blue 500', '#2196f3'],
      ['Light Blue 500', '#03a9f4'],
      ['Cyan 500', '#00bcd4'],
      ['Teal 500', '#009688'],
      ['Green 500', '#4caf50'],
      ['Light Green 500', '#8bc34a'],
      ['Lime 500', '#cddc39'],
      ['Yellow 500', '#ffeb3b'],
      ['Amber 500', '#ffc107'],
      ['Orange 500', '#ff9800'],
      ['Deep Orange 500', '#ff5722'],
      ['Brown 500', '#795548'],
      ['Grey 500', '#9e9e9e'],
      ['Blue Grey 500', '#607d8b'],
    ],
  },
  {
    id: 'flatui',
    name: 'Flat UI',
    colors: [
      ['Turquoise', '#1abc9c'],
      ['Green Sea', '#16a085'],
      ['Emerald', '#2ecc71'],
      ['Nephritis', '#27ae60'],
      ['Peter River', '#3498db'],
      ['Belize Hole', '#2980b9'],
      ['Amethyst', '#9b59b6'],
      ['Wisteria', '#8e44ad'],
      ['Wet Asphalt', '#34495e'],
      ['Midnight Blue', '#2c3e50'],
      ['Sun Flower', '#f1c40f'],
      ['Orange', '#f39c12'],
      ['Carrot', '#e67e22'],
      ['Pumpkin', '#d35400'],
      ['Alizarin', '#e74c3c'],
      ['Pomegranate', '#c0392b'],
      ['Clouds', '#ecf0f1'],
      ['Silver', '#bdc3c7'],
      ['Concrete', '#95a5a6'],
      ['Asbestos', '#7f8c8d'],
    ],
  },
  {
    id: 'pastels',
    name: 'Pastels',
    colors: [
      ['Pastel Pink', '#ffd1dc'],
      ['Pastel Rose', '#f8c8dc'],
      ['Pastel Peach', '#ffdab9'],
      ['Pastel Yellow', '#fdfd96'],
      ['Pastel Mint', '#bdfcc9'],
      ['Pastel Green', '#c1e1c1'],
      ['Pastel Aqua', '#b2ebf2'],
      ['Pastel Blue', '#aec6cf'],
      ['Pastel Periwinkle', '#c3c7f5'],
      ['Pastel Lavender', '#e3d0f7'],
      ['Pastel Lilac', '#d8b4e2'],
      ['Pastel Gray', '#dcdcdc'],
    ],
  },
  {
    id: 'earth',
    name: 'Earth tones',
    colors: [
      ['Sand', '#e6d3a3'],
      ['Khaki', '#c3b091'],
      ['Clay', '#b66a50'],
      ['Terracotta', '#c1440e'],
      ['Rust', '#8b3a1e'],
      ['Umber', '#635147'],
      ['Sienna', '#a0522d'],
      ['Ochre', '#cc7722'],
      ['Olive', '#6b6b2f'],
      ['Moss', '#4f6d3a'],
      ['Forest', '#2f4f2f'],
      ['Slate', '#5b6770'],
      ['Charcoal', '#36454f'],
      ['Bark', '#4a3728'],
    ],
  },
  {
    id: 'neon',
    name: 'Neon',
    colors: [
      ['Neon Pink', '#ff10f0'],
      ['Neon Magenta', '#ff00cc'],
      ['Neon Red', '#ff3131'],
      ['Neon Orange', '#ff7a00'],
      ['Neon Yellow', '#ccff00'],
      ['Neon Green', '#39ff14'],
      ['Neon Mint', '#0aff99'],
      ['Neon Cyan', '#00f0ff'],
      ['Neon Blue', '#1f51ff'],
      ['Neon Purple', '#bc13fe'],
    ],
  },
  {
    id: 'skin',
    name: 'Skin tones',
    colors: [
      ['Porcelain', '#fde7d6'],
      ['Ivory', '#f5dcc4'],
      ['Light', '#f1c9a5'],
      ['Warm Beige', '#e8b48a'],
      ['Sand', '#d9a06f'],
      ['Honey', '#c98a5b'],
      ['Caramel', '#b5744a'],
      ['Tan', '#a05f3a'],
      ['Chestnut', '#8a4a2b'],
      ['Umber', '#6b3a22'],
      ['Espresso', '#4d2a17'],
      ['Ebony', '#331a0f'],
    ],
  },
];

export function libraryById(id: string): SwatchLibrary | undefined {
  return SWATCH_LIBRARIES.find((l) => l.id === id);
}
