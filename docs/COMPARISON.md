# OPuller и Adobe Illustrator: что есть, чего нет

Документ описывает состояние OPuller на 2026-09-08 (версия 0.1.0) и честно сравнивает его
с Adobe Illustrator 2025.

## 1. Инвентарь OPuller

### Инструменты (38)

| Группа | Инструменты (клавиша) |
| --- | --- |
| Выделение | Selection (V), Direct Selection (A), Lasso (Q) |
| Перо | Pen (P), Add Anchor (=), Delete Anchor (-), Anchor Point (Shift+C), Curvature (Shift+`) |
| Рисование | Pencil (N), Paintbrush (B), Blob Brush (Shift+B), Smooth, Path Eraser, Pixel Brush (растр) |
| Фигуры | Rectangle (M), Rounded Rectangle, Ellipse (L), Polygon, Star, Line (\) — все «живые» с параметрами |
| Текст | Type (T): точечный, блочный, по контуру |
| Трансформация | Rotate (R), Scale (S), Reflect (O), Shear, Free Transform (E) |
| Редактирование | Shape Builder (Shift+M), Eraser (Shift+E), Scissors (C), Knife (K), Width (Shift+W), Blend (W), Gradient (G), Eyedropper (I), Measure |
| Документ | Artboard (Shift+O), Hand (H), Zoom (Z) |

У каждого инструмента есть панель опций в верхней полосе (Control bar), модификаторы Shift/Alt/Ctrl,
привязка (сетка, направляющие, точки, smart guides), подсказки в статус-баре, курсоры.

### Панели (18) и экраны

Properties, Transform, Align, Pathfinder, Color (HSB/RGB/HEX, пипетка), Swatches (библиотеки),
Gradient, Stroke (толщина, концы, углы, пунктир, стрелки, профиль ширины), Layers (дерево,
drag & drop, миниатюры, блокировка/видимость, цвета слоёв), Artboards, History, Navigator, Info,
Character, Paragraph, Appearance, Effects. Плюс Home-экран (библиотека проектов с превью, недавние
файлы, пресеты, примеры, обучение, подключение ИИ), диалоги New Document / Document Setup / Export /
Preferences / Keyboard Shortcuts / About.

### Операции над объектами

* Pathfinder: Unite, Minus Front, Intersect, Exclude, Minus Back, Divide, Trim, Merge, Crop, Outline.
* Shape Builder: объединение/вычитание областей перетаскиванием.
* Path: Join, Average, Outline Stroke, Offset Path, Simplify, Add/Remove Anchor Points,
  Reverse, Divide Objects Below, Clean Up; Compound Path (make/release); Clipping Mask (make/release).
* Blend: по шагам / по расстоянию / плавный цвет, живое обновление, Release/Expand/Reverse.
* Transform: Move/Rotate/Reflect/Scale/Shear с превью и Copy, Transform Each, Transform Again (Ctrl+D),
  Reset Bounding Box, Align/Distribute (к выделению/артборду/ключевому объекту).
* Arrange, Group/Ungroup, Isolation mode, Lock/Hide, Expand, Rasterize.
* Изображения: Place, Image Trace (пресеты, ч/б, серый, цвет, превью), Crop, сброс кадрирования,
  экспорт оригинала, Pixel Brush для растровых слоёв.
* Эффекты (живые, редактируемые): Drop Shadow, Inner Shadow, Outer/Inner Glow, Gaussian Blur,
  Round Corners, цветокоррекция (яркость/контраст/насыщенность/оттенок/сепия/инверсия), режимы
  наложения, непрозрачность.
* Текст: 14 встроенных семейств + системные шрифты + загрузка своих (TTF/OTF/WOFF), стили
  участков (rich text), Create Outlines, Type on a Path (flip/release), выравнивание, кернинг/трекинг,
  интерлиньяж, регистр.
* Артборды: несколько на документ, пресеты (печать/веб/мобильные/соцсети/иконки), Fit to Artwork,
  Rearrange, Convert to Artboards, экспорт по артбордам.

### Файлы и обмен

* Проекты `.opuller` (JSON, картинки внутри) — сохранение на диск и в библиотеку браузера
  (IndexedDB) с автосохранением и превью; восстановление после сбоя; недавние файлы.
* Импорт: SVG (в редактируемые объекты), PNG/JPEG/WebP/GIF (Place, drag & drop, буфер обмена).
* Экспорт: SVG, PNG, JPEG, WebP, PDF — по артборду, всем артбордам или выделению, с масштабом,
  фоном, шрифтами.
* Буфер обмена: копирование/вставка объектов, SVG-текст, вставка изображений.

### ИИ

Встроенный MCP-сервер (47 инструментов): чтение/изменение документа, любые команды и инструменты,
жесты мыши, экспорт, скриншоты, библиотека проектов. То же API — в консоли `window.__opuller.mcp`.

## 2. Сравнение с Illustrator

### Что есть в обоих (паритет или близко)

| Область | Illustrator | OPuller | Комментарий |
| --- | --- | --- | --- |
| Перо и якоря | ✔ | ✔ | Pen/Curvature/Anchor Point, добавление/удаление, smooth/corner, привязка |
| Живые фигуры | ✔ | ✔ | прямоугольник со скруглениями, эллипс, многоугольник, звезда, линия |
| Pathfinder / Shape Builder | ✔ | ✔ | все 10 операций Pathfinder + Shape Builder |
| Градиенты | линейный, радиальный, freeform, mesh | линейный, радиальный | редактирование на холсте, стопы, панель |
| Обводки | ✔ | ✔ | пунктир, концы, стрелки, Width tool, Outline Stroke |
| Эффекты | большой набор (Stylize, Distort, 3D, SVG-фильтры…) | Stylize + Blur + цвет | живые, в панели Appearance |
| Текст | ✔ | ✔ (базовый набор) | точечный/блочный/по контуру, outlines; нет переносов, OpenType-фич, вертикального текста |
| Трансформации | ✔ | ✔ | все инструменты, диалоги с превью/копией, Transform Each/Again |
| Blend | ✔ | ✔ | нет спайна по произвольному пути и ориентации к спайну |
| Артборды | ✔ | ✔ | панель, инструмент, пресеты, экспорт по артбордам |
| Слои | ✔ | ✔ | вложенность, DnD, миниатюры, блокировки |
| Image Trace | ✔ (продвинутый) | ✔ (базовый) | нет режима «предустановок с палитрой из документа», нет углов/дуг |
| Экспорт | AI, EPS, PDF, SVG, PNG… | SVG, PDF, PNG, JPEG, WebP, .opuller | формат AI/EPS не поддерживается |
| Растр | Rasterize, Crop, эффекты | Rasterize, Crop, Pixel Brush, цветокоррекция | |
| Домашний экран | Home (облачные документы) | Home (библиотека в браузере, превью, поиск) | |
| Скрипты/автоматизация | ExtendScript/UXP, Actions | MCP-сервер + JS API | у OPuller ИИ управляет всеми инструментами |

### Чего в OPuller нет (и что это значит)

| Отсутствует | Насколько важно | Возможная замена сейчас |
| --- | --- | --- |
| CMYK, плашечные цвета, цветопроба, метки печати/вылеты | критично для типографии | RGB-документы; для печати экспортировать PDF/SVG и конвертировать |
| Формат AI/EPS/PDF на импорт | важно при обмене с дизайнерами | SVG (Illustrator экспортирует SVG без потерь для большинства работ) |
| Символы и панель Symbols, Symbol Sprayer | средне | группы + Duplicate; MCP может тиражировать |
| Кисти (каллиграфические/художественные/узорные/scatter), Brushes panel | средне | Paintbrush даёт заливочные штрихи фиксированной формы; Width tool |
| Паттерны (панель узоров, Pattern Editing) | средне | модель хранит `patterns`, UI не реализован |
| Mesh-градиенты, Freeform gradient | средне | радиальные градиенты + blend |
| Envelope Distort, Warp, Puppet Warp, Perspective Grid, 3D | средне/низко | нет |
| Live Paint | низко (Shape Builder покрывает) | Shape Builder |
| Recolor Artwork, глобальные цвета | средне | Select > Same Fill + панель Color, библиотеки образцов |
| Graphs (диаграммы) | низко | нет |
| Repeat (radial/grid/mirror), Global Edit | низко | Transform Each + Duplicate |
| Продвинутый текст: переносы, OpenType-features, глифы, вертикальный набор, связанные блоки, стили абзацев/символов | средне | базовый rich-text |
| Плагины, Actions, библиотеки Creative Cloud | низко для одиночной работы | MCP/JS |
| Печать напрямую | низко | PDF |

### Что у OPuller лучше или иначе

* Открытый формат проекта (JSON), всё редактируемо снаружи.
* Управление ИИ через MCP: ассистент видит документ, рисует, комбинирует и проверяет результат
  скриншотом.
* Работает в браузере, ставится из репозитория, без подписки; данные остаются локально.
* Тесты: 147 unit + 113 e2e сценариев покрывают инструменты, панели, экспорт и ИИ-мост.

### Итоговая оценка покрытия

Грубо по объёму типичной работы с логотипами, иконками, иллюстрациями и веб-графикой OPuller
закрывает порядка **70–80 %** повседневных функций Illustrator. Основные разрывы — печать/CMYK,
форматы AI/EPS, символы/кисти/узоры и продвинутая типографика.
