# OPuller и Adobe Illustrator: что есть, чего нет

Документ описывает состояние OPuller на 2026-09-11 (версия 0.1.0) и честно сравнивает его
с Adobe Illustrator 2025.

## 1. Инвентарь OPuller

### Инструменты (52)

| Группа | Инструменты (клавиша) |
| --- | --- |
| Выделение | Selection (V), Direct Selection (A), Lasso (Q), Perspective Selection (Shift+V) |
| Перо | Pen (P), Add Anchor (=), Delete Anchor (-), Anchor Point (Shift+C), Curvature (Shift+`) |
| Рисование | Pencil (N), Paintbrush (B) с кистями, Blob Brush (Shift+B), Smooth, Path Eraser, Pixel Brush (растр) |
| Фигуры | Rectangle (M), Rounded Rectangle, Ellipse (L), Polygon, Star, Line (\) — все «живые» с параметрами |
| Текст | Type (T): точечный, блочный, по контуру |
| Трансформация | Rotate (R), Scale (S), Reflect (O), Shear, Free Transform (E) |
| Редактирование | Shape Builder (Shift+M), Live Paint Bucket (K), Live Paint Selection (Shift+L), Eraser (Shift+E), Scissors (C), Knife, Width (Shift+W), Blend (W), Gradient (G) с freeform-режимом, Mesh (U), Eyedropper (I), Measure |
| Деформация (Liquify) | Warp (Shift+R), Twirl, Pucker, Bloat, Scallop, Crystallize, Wrinkle — эллиптическая кисть с общими размерами (Alt-drag меняет размер, Shift — пропорционально), Detail / Simplify, Intensity, Complexity, Options-диалог |
| Символы, диаграммы, перспектива | Symbol Sprayer (Shift+S) с режимами shift/size/spin/screen, Graph (J), Perspective Grid (Shift+P) |
| Документ | Artboard (Shift+O), Hand (H), Zoom (Z) |

У каждого инструмента есть панель опций в верхней полосе (Control bar), модификаторы Shift/Alt/Ctrl,
привязка (сетка, направляющие, точки, smart guides), подсказки в статус-баре, курсоры.

### Панели (19) и экраны

Properties, Transform, Align, Pathfinder, Color (HSB/RGB/CMYK/HEX, оттенок глобального цвета,
пипетка), Swatches (процессные, глобальные и плашечные образцы, узоры, библиотеки печати и
Pantone-подобные плашечные), Gradient (линейный/радиальный/freeform), Stroke (толщина, концы,
углы, пунктир, стрелки, профиль ширины), Layers (дерево, drag & drop, миниатюры,
блокировка/видимость, цвета слоёв), Artboards, Symbols (библиотека из 16 символов), Brushes
(20 кистей четырёх типов), History, Navigator, Info, Character, Paragraph, Appearance, Effects.
Плюс Home-экран (библиотека проектов с превью, недавние файлы, пресеты, примеры, обучение,
подключение ИИ), диалоги New Document / Document Setup (цветовой режим, вылеты) / Export /
Recolor Artwork / Warp / 3D / Graph Data / Define Perspective Grid / Preferences / Keyboard
Shortcuts / About.

### Цвет и печать

* Документ в режиме RGB или CMYK (File > Document Color Mode); в CMYK панель Color редактирует
  краски, образцы хранят значения CMYK.
* Образцы: процессные, **глобальные** (правка образца перекрашивает все объекты, оттенок в
  процентах) и **плашечные** (spot; отдельная краска, `[Registration]`); библиотеки печатных CMYK
  и плашечных цветов.
* Edit > Edit Colors: Recolor Artwork (диалог с цветовыми группами, гармониями, сокращением
  числа цветов, случайным перемешиванием), Adjust Color Balance, Saturate, Blend Front to
  Back / Horizontally / Vertically, Convert to Grayscale / CMYK / RGB, Invert Colors.
* Печать: вылеты (bleed) документа, красные направляющие вылетов на холсте, экспорт SVG / PDF /
  EPS с вылетами и типографскими метками (обрезные, приводочные, цветовые шкалы, информация о
  странице).

### Операции над объектами

* Pathfinder: Unite, Minus Front, Intersect, Exclude, Minus Back, Divide, Trim, Merge, Crop, Outline.
* Shape Builder и **Live Paint**: группа Live Paint режет контуры по пересечениям на грани и
  рёбра, ведро закрашивает грани/рёбра, Release/Expand.
* Path: Join, Average, Outline Stroke, Offset Path, Simplify, Add/Remove Anchor Points,
  Reverse, Divide Objects Below, Clean Up; Compound Path (make/release); Clipping Mask (make/release).
* Blend: по шагам / по расстоянию / плавный цвет, живое обновление, Release/Expand/Reverse.
* Transform: Move/Rotate/Reflect/Scale/Shear с превью и Copy, Transform Each, Transform Again (Ctrl+D),
  Reset Bounding Box, Align/Distribute (к выделению/артборду/ключевому объекту).
* Arrange, Group/Ungroup, Isolation mode, Lock/Hide, Expand, Expand Appearance, Rasterize.
* **Символы**: Object > Symbol (Make F8, Place, Break Link, Edit в изоляции, Redefine, Select
  All Instances, Expand Set), инстансы с версией обновляются при переопределении, Symbol
  Sprayer с наборами символов.
* **Кисти**: каллиграфические, разбросные (scatter), художественные (art) и узорные
  (pattern) — живые (обводка хранит кисть, геометрия строится вдоль контура), Brush Options,
  New Brush из выделения, Expand Appearance превращает штрих в обычные контуры, библиотека.
* **Узоры**: Object > Pattern > Make из выделения, режим редактирования плитки на холсте,
  Pattern Options (раскладки grid / brick / hex, смещение, интервал, фон), Fill Options
  (масштаб, угол, смещение), Expand, библиотека из 15 узоров.
* **Градиенты**: линейный, радиальный, **freeform** (точки и линии, редактирование на холсте),
  **mesh** (Object > Create Gradient Mesh, Mesh tool: узлы, касательные, добавление/удаление
  строк и столбцов, раскраска узлов из панели Color), Release Mesh.
* **Envelope Distort и Warp**: Make with Warp (15 стилей: arc, arch, bulge, flag, wave, fish,
  rise, fisheye, inflate, squeeze, twist…), Make with Mesh (сетка деформации, точки двигает
  Mesh tool), Make with Top Object (контур-конверт), Free Distort, Release / Expand / Edit
  Contents — всё живыми эффектами.
* **3D**: Extrude & Bevel (глубина, скос, крышки, освещение, поворот пресетами и по осям),
  Revolve (вращение вокруг оси со смещением), Rotate — живые эффекты с гранями и затенением,
  Expand Appearance раскладывает на контуры.
* **Perspective Grid**: одно-, двух- и трёхточечная сетка (View > Perspective Grid, Define
  Grid), инструмент сетки с ручками (точки схода, горизонт, начало, высота, глубина),
  переключатель активной плоскости (виджет, клавиши 1/2/3), фигуры рисуются сразу на активной
  плоскости, Perspective Selection перемещает объекты вдоль плоскости, Object > Perspective:
  Attach to Active Plane, Release with Perspective, Remove Perspective, Move Plane to Match Object.
* **Graphs**: 9 типов (столбчатая, с накоплением, линейчатая, линейная, площади, точечная,
  круговая, лепестковая), таблица данных, тип, легенда/оси/подписи, перегенерация и Refit,
  инструмент Graph (J).
* Изображения: Place, **Image Trace** (собственный движок: квантование цветов median cut +
  k-means + слияние Уорда, кривые potrace, 10 пресетов, режимы ч/б / серый / цвет, Threshold /
  Colors / Grays, Paths / Corners / Noise, Abutting / Overlapping, Fills / **Strokes** (тонкие
  линии — обводками по центральной линии: скелетизация, Max Stroke Weight, Min Stroke Length),
  Snap curves to lines, Ignore white, живое превью в Web Worker), Crop, сброс кадрирования,
  экспорт оригинала, Pixel Brush для растровых слоёв.
* Эффекты (живые, редактируемые): Drop Shadow, Inner Shadow, Outer/Inner Glow, Gaussian Blur,
  Round Corners, цветокоррекция, Warp, Free Distort, Envelope Mesh, 3D Extrude/Revolve/Rotate,
  режимы наложения, непрозрачность.
* Текст: 14 встроенных семейств + системные шрифты + загрузка своих (TTF/OTF/WOFF), стили
  участков (rich text), Create Outlines, Type on a Path (flip/release), выравнивание, кернинг/трекинг,
  интерлиньяж, регистр.
* Артборды: несколько на документ, пресеты (печать/веб/мобильные/соцсети/иконки), Fit to Artwork,
  Rearrange, Convert to Artboards, экспорт по артбордам.

### Файлы и обмен

* Проекты `.opuller` (JSON, картинки внутри) — сохранение на диск и в библиотеку браузера
  (IndexedDB) с автосохранением и превью; восстановление после сбоя; недавние файлы.
* Импорт: SVG (в редактируемые объекты), **PDF и PDF-совместимые AI** (pdf.js: контуры,
  заливки/обводки, обтравка, картинки, текст; или растровая страница), **классические AI /
  EPS** (интерпретатор PostScript: операторы AI 8 и обычные PostScript, слои, группы,
  составные контуры, CMYK, текст), PNG/JPEG/WebP/GIF (Place, drag & drop, буфер обмена).
* Экспорт: SVG, PNG, JPEG, WebP, PDF, **EPS** (Level 3, градиенты shfill, картинки, CMYK),
  **AI** — нативный формат Illustrator 7/8 (слои с именами и видимостью, группы, составные
  контуры, обтравочные маски, заливки/обводки с пунктиром, линейные и радиальные градиенты,
  spot-цвета с оттенком, точечный и блочный текст, растровые картинки; кисти, узоры, эффекты и
  переменная ширина обводки разворачиваются, текст вне Latin-1 переводится в кривые) или
  PDF-совместимый `.ai` — по артборду, всем артбордам или выделению, с масштабом, фоном,
  шрифтами, вылетами и метками.
* Буфер обмена: копирование/вставка объектов, SVG-текст, вставка изображений.

### ИИ

Встроенный MCP-сервер (59 инструментов): чтение/изменение документа, любые команды и инструменты,
жесты мыши, экспорт и импорт файлов (PDF/AI/EPS/SVG/растр), скриншоты, библиотека проектов,
символы, кисти, узоры, градиенты (mesh/freeform), Live Paint, диаграммы, перспектива, liquify-кисти,
Image Trace. То же API — в консоли `window.__opuller.mcp`.

## 2. Сравнение с Illustrator

### Что есть в обоих (паритет или близко)

| Область | Illustrator | OPuller | Комментарий |
| --- | --- | --- | --- |
| Перо и якоря | ✔ | ✔ | Pen/Curvature/Anchor Point, добавление/удаление, smooth/corner, привязка |
| Живые фигуры | ✔ | ✔ | прямоугольник со скруглениями, эллипс, многоугольник, звезда, линия |
| Pathfinder / Shape Builder / Live Paint | ✔ | ✔ | все 10 операций Pathfinder, Shape Builder, Live Paint Bucket + Selection |
| Градиенты | линейный, радиальный, freeform, mesh | линейный, радиальный, freeform, mesh | mesh-градиент рендерится растровой плиткой (Coons-патчи), в SVG экспортируется картинкой |
| Обводки и кисти | ✔ | ✔ | пунктир, концы, стрелки, Width tool, Outline Stroke; 4 типа кистей, Brushes panel |
| Символы | ✔ | ✔ | панель, библиотека, Sprayer с режимами; нет 9-slice и динамических символов |
| Узоры | ✔ | ✔ | Pattern Editing, раскладки, Fill Options; нет «размер плитки по объекту» отдельно от границ |
| Цвет | RGB/CMYK, spot, глобальные, Recolor Artwork | RGB/CMYK, spot, глобальные, Recolor Artwork | нет ICC-профилей и цветопробы (CMYK ↔ RGB — формульный, не профильный) |
| Печать | вылеты, метки, разделения | вылеты, метки в SVG/PDF/EPS | нет цветоделения и overprint-превью |
| Эффекты | большой набор (Stylize, Distort, 3D, SVG-фильтры…) | Stylize + Blur + цвет + Warp/Distort + 3D | 3D без материалов/текстур и raytracing |
| Envelope / Warp / Liquify | ✔ | ✔ | Warp, Mesh, Top Object; семь liquify-кистей (Warp, Twirl, Pucker, Bloat, Scallop, Crystallize, Wrinkle); нет Puppet Warp |
| Perspective Grid | ✔ | ✔ | 1/2/3-точечная сетка, привязка объектов, перемещение по плоскости; нет перпендикулярного перемещения и сеток-пресетов по имени |
| Graphs | ✔ (9 типов) | ✔ (9 типов) | нет «дизайнов» столбцов из символов |
| Текст | ✔ | ✔ (базовый набор) | точечный/блочный/по контуру, outlines; нет переносов, OpenType-фич, вертикального текста |
| Трансформации | ✔ | ✔ | все инструменты, диалоги с превью/копией, Transform Each/Again |
| Blend | ✔ | ✔ | нет спайна по произвольному пути и ориентации к спайну |
| Артборды | ✔ | ✔ | панель, инструмент, пресеты, экспорт по артбордам |
| Слои | ✔ | ✔ | вложенность, DnD, миниатюры, блокировки |
| Image Trace | ✔ | ✔ | пресеты, Paths / Corners / Noise, Abutting / Overlapping, Fills / Strokes (центральные линии), Snap Curves, Ignore White, превью; нет палитры из образцов документа |
| Форматы | AI, EPS, PDF, SVG, PNG… | AI (Illustrator 8 нативный и PDF-совместимый), SVG, PDF, EPS, PNG, JPEG, WebP, .opuller; импорт AI (PDF-совместимые и классические, с градиентами и картинками), EPS, PDF | в AI 8 нет прозрачности, режимов наложения и живых эффектов (разворачиваются или отбрасываются с предупреждением) |
| Растр | Rasterize, Crop, эффекты | Rasterize, Crop, Pixel Brush, цветокоррекция | |
| Домашний экран | Home (облачные документы) | Home (библиотека в браузере, превью, поиск) | |
| Скрипты/автоматизация | ExtendScript/UXP, Actions | MCP-сервер + JS API | у OPuller ИИ управляет всеми инструментами |

### Чего в OPuller нет (и что это значит)

| Отсутствует | Насколько важно | Возможная замена сейчас |
| --- | --- | --- |
| ICC-профили, цветопроба, цветоделение, overprint | важно для серьёзной типографии | CMYK-документ + PDF/EPS с метками; профили применяет типография |
| Puppet Warp, Repeat (radial/grid/mirror), Global Edit | низко | Liquify-кисти и Envelope Mesh; эффект Transform с копиями; Transform Each + Duplicate |
| 3D-материалы, текстуры, тени с трассировкой | низко | Extrude/Revolve/Rotate с затенением |
| Продвинутый текст: переносы, OpenType-features, глифы, вертикальный набор, связанные блоки, стили абзацев/символов | средне | базовый rich-text |
| Динамические символы, 9-slice | низко | Redefine символа |
| Плагины, Actions, библиотеки Creative Cloud | низко для одиночной работы | MCP/JS |
| Печать напрямую | низко | PDF |

### Что у OPuller лучше или иначе

* Открытый формат проекта (JSON), всё редактируемо снаружи.
* Управление ИИ через MCP: ассистент видит документ, рисует, комбинирует и проверяет результат
  скриншотом; символы, кисти, узоры, диаграммы и перспектива тоже доступны через инструменты MCP.
* Работает в браузере, ставится из репозитория, без подписки; данные остаются локально.
* Тесты: 230 unit + 144 e2e сценариев покрывают инструменты, панели, экспорт/импорт и ИИ-мост.

### Шаги уроков Illustrator → OPuller

Таблица соответствия для повторения пошаговых уроков (через UI или MCP). Известные различия
отмечены отдельно.

| Illustrator | OPuller (UI) | OPuller (MCP) |
| --- | --- | --- |
| Прямоугольник со скруглёнными углами, разные радиусы (Transform → Corners) | Properties → Shape: четыре радиуса; каждый угол может занять всю сторону минус сосед | `opuller_create_shape {kind:"rect", radii:[tl,tr,br,bl]}`, `opuller_update_nodes {patch:{shape:{radii}}}` |
| Живые углы (corner widget, Direct Selection) | инструмент Direct Selection (A): кружок внутри каждого угла — тянуть; двойной клик — диалог Corners; Object → Path → Corners… | `opuller_corners {ids, radius, anchors?}`, `opuller_pen {anchors:[{…, cornerRadius}]}` |
| Effect → Distort & Transform → Zig Zag / Pucker & Bloat / Roughen / Transform / Tweak | те же пункты меню Effect → Distort & Transform; панель Appearance правит параметры | `opuller_effect {op:"add", type:"zigZag"|"puckerBloat"|"roughen"|"transform"|"tweak", params}` |
| Effect → Warp (Arc, Bulge, …) | Effect → Distort & Transform → Warp… | `opuller_effect {type:"warp", params:{style, bend, horizontal, hDistort, vDistort}}` |
| Effect → Stylize → Round Corners | Effect → Stylize → Round Corners (работает и после варпа) | `opuller_effect {type:"roundCorners", params:{radius}}` |
| Object → Expand Appearance | Object → Expand Appearance | `opuller_effect {op:"expand"}` |
| Rotate (R), угол +26° | инструмент Rotate / диалог Transform → Rotate; плюс = против часовой | `opuller_transform {rotate: 26}` (против часовой) |
| Scale + «Scale Strokes & Effects», «Scale Corners» | Preferences → Scale strokes; диалог Transform | `opuller_transform {scale, scaleStrokes, scaleEffects, scaleCorners}` |
| Align → Horizontal/Vertical Align Center, Align to Artboard / Key Object, Distribute Spacing | панель Align (Shift+F7) | `opuller_align {h, v, to, key, distribute, spacing}` |
| Object → Blend → Make / Blend Options (Specified Steps) | Object → Blend → Make (Ctrl+Alt+B), Blend Options… | `opuller_blend {op:"make", steps}` / `{op:"options", spacing, distance}` / `expand` |
| Object → Path → Offset Path | Object → Path → Offset Path… | `opuller_offset_path {distance, join, mode}` |
| Object → Path → Simplify | Object → Path → Simplify… | `opuller_simplify {tolerance, cornerAngle}` |
| Pathfinder → Minus Front / Unite … | панель Pathfinder | `opuller_pathfinder {op}` (мелкие «огрызки» удаляются, `cleanup:false` — оставить) |
| Pencil (N) с текущей заливкой | Pencil: рисует текущим оформлением (выделение объекта делает его стиль текущим, как в Illustrator) | `opuller_set_appearance {fill, stroke}` → `opuller_pencil {points, fidelity, smoothness, fillStrokes}` |
| Pen (P) | Pen | `opuller_pen {anchors:[{x, y, handleIn, handleOut}], closed}` |
| Warp Tool (Shift+R), широкий мазок | инструменты Liquify (кисть — Alt-перетаскивание) | `opuller_liquify {kind:"warp", points:[…], options:{width, intensity}}` |
| Swatches → New Swatch / Global | панель Swatches | `opuller_swatches {op:"add", name, color, kind:"global"}`, `{op:"apply", name, target, tint}` |
| Шрифт из файла (Champion HTF и т. п.) | Character → семейство → «Upload font…» | `opuller_fonts {op:"load", file}` |
| Save As → Illustrator (.ai) | File → Export → AI (Illustrator 8 или PDF-совместимый) | `opuller_export_file {file:"x.ai", text:"auto"}` — кодировка кириллицы выбирается сама |

Известные отличия от Illustrator:

* Warp (15 стилей, bend, Horizontal/Vertical distortion, обе оси) воспроизводит Illustrator
  точно: это один бикубический Безье-патч, снятый с Illustrator 2026 (`tests/fixtures/warp/`,
  расхождение решётки ≤ 0.1 px). Прямые стороны вдоль осей превращаются в одиночные кривые —
  прямоугольник после Expand даёт 4 узла с ручками, как в Illustrator; кривые и наклонные
  отрезки дробятся на короткие сегменты и отображаются по контрольным точкам (приближение).
* Pucker & Bloat и Zig Zag сняты с Illustrator 2026 и совпадают с ним по узлам и ручкам
  (`tests/fixtures/effects/`, ≤ 0.01 px): Pucker & Bloat двигает узлы к центру габарита, а концы
  ручек — от него на тот же процент; Zig Zag ставит `ridges` пиков на сегмент через равные длины
  дуги, и узлы контура тоже участвуют в зигзаге (знак чередуется по всем точкам подряд), нормаль
  в узле — взвешенная по сторонам; в режиме Smooth ручки прямых сторон = половина шага, кривых —
  ручки кусков Безье после разбиения. Не воспроизводится только сдвиг последней точки замкнутого
  контура (артефакт Illustrator, < 1 px в режиме Corner). «Relative» в Zig Zag Illustrator
  пересчитывает в абсолютную величину ещё в диалоге, поэтому в OPuller это по-прежнему % длины
  сегмента. Roughen, Tweak, Transform, Round Corners, Offset Path пока не сверялись.
* Эффекты применяются в порядке списка панели Appearance (как в Illustrator); живые углы
  (corner widget) — до эффектов.
* Углы поворота везде против часовой стрелки; файлы проектов формата 1 (угол узора,
  вращение scatter-кисти) мигрируют при открытии.
* Radius прямоугольника обрезается по-угловому: пара радиусов, не влезающая в сторону,
  масштабируется пропорционально (CSS `border-radius`), остальные углы не трогаются.

### Итоговая оценка покрытия

По объёму типичной работы с логотипами, иконками, иллюстрациями, упаковкой и веб-графикой
OPuller закрывает порядка **85–90 %** повседневных функций Illustrator. Оставшиеся разрывы —
профильное управление цветом и цветоделение, продвинутая типографика, запись `.ai`, Puppet
Warp/Repeat и 3D-материалы.
