#!/usr/bin/env node
/**
 * orca-figma.mjs — чтение макетов Figma через встроенный браузер Orca.
 *
 * Зачем: у агента нет Figma MCP, но макет открыт во встроенном браузере Orca.
 * Figma-канвас — WebGL, из DOM/a11y-снимка он не читается, поэтому работаем
 * визуально: зум + панорама + скриншоты, которые агент читает как изображения.
 *
 * Запуск:  node orca-figma.mjs <команда> [аргументы]
 *
 * Команды:
 *   tabs                          список вкладок браузера Orca
 *   open <url>                    открыть URL в новой вкладке
 *   geom                          innerWidth/innerHeight/dpr (реальная геометрия)
 *   fit                           «Zoom to fit» через меню зума Figma
 *   zoom <x> <y> <ticks>          зум колесом (ctrl+wheel) в CSS-точке
 *   pan  <x> <y> <dx> <dy>        панорама колесом в CSS-точке
 *   shot <path>                   скриншот вкладки в файл (png)
 *   eval <js>                     выполнить JS в контексте страницы
 *   send <agent-browser command>  произвольная команда (mouse move/down/up, wheel, keydown...)
 *   press <key>                   нажать клавишу (Escape, Shift+1, ...)
 *
 * ГЛАВНОЕ ПРАВИЛО: перед zoom/pan всегда делается mouse move в ту же CSS-точку —
 * Figma зумит/панорамирует относительно РЕАЛЬНОЙ позиции курсора, а не относительно
 * clientX/clientY синтетического события.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

const ORCA = process.env.ORCA_CLI_COMMAND || 'orca';

function runOrca(args) {
  const full = [...args, '--json'];
  const opts = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  const attempts = 8;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = execFileSync(ORCA, full, opts);
      if (!out.includes('runtime_unavailable')) return out;
      lastErr = new Error('runtime_unavailable');
    } catch (e) {
      // Windows: .cmd иногда требует shell
      try {
        const out = execFileSync(ORCA, full, { ...opts, shell: true });
        if (!out.includes('runtime_unavailable')) return out;
        lastErr = e;
      } catch (e2) {
        lastErr = e2;
      }
    }
    // Orca-рантайм иногда рвёт соединение на «тяжёлой» команде — это транзиентно
    sleep(3000);
  }
  throw lastErr || new Error('orca command failed');
}

function sleep(ms) {
  execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' });
}

function jsonOrThrow(raw) {
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new Error('orca вернул не JSON: ' + raw.slice(0, 300));
  }
  if (o.ok === false) throw new Error(o.error?.code + ': ' + o.error?.message);
  return o.result ?? o;
}

const send = (cmd) => jsonOrThrow(runOrca(['exec', '--command', cmd]));
const evaluate = (js) => jsonOrThrow(runOrca(['eval', '--expression', js]));

const wheelJs = (x, y, ticks, ctrl) =>
  `(function(){var x=${x},y=${y},n=${Math.abs(ticks)},` +
  `d=${ctrl ? 120 * Math.sign(ticks) : 0};` +
  `var t=document.elementFromPoint(x,y)||document.body;` +
  `for(var i=0;i<n;i++){t.dispatchEvent(new WheelEvent('wheel',` +
  `{deltaY:d,deltaMode:0,ctrlKey:${ctrl},clientX:x,clientY:y,` +
  `bubbles:true,cancelable:true,view:window}));}return 'ok';})()`;

const panJs = (x, y, dx, dy) =>
  `(function(){var x=${x},y=${y};var t=document.elementFromPoint(x,y)||document.body;` +
  `t.dispatchEvent(new WheelEvent('wheel',{deltaX:${dx},deltaY:${dy},deltaMode:0,` +
  `ctrlKey:false,clientX:x,clientY:y,bubbles:true,cancelable:true,view:window}));` +
  `return 'ok';})()`;

function refByName(refs, re) {
  const hit = Object.entries(refs).find(([, v]) => re.test(v.name || ''));
  return hit ? hit[0] : null;
}

const commands = {
  tabs() {
    return JSON.stringify(jsonOrThrow(runOrca(['tab', 'list']))?.tabs ?? [], null, 2);
  },
  open(url) {
    return JSON.stringify(jsonOrThrow(runOrca(['tab', 'create', '--url', url])), null, 2);
  },
  geom() {
    const g = evaluate(
      "JSON.stringify({innerWidth:window.innerWidth,innerHeight:window.innerHeight," +
      "devicePixelRatio:window.devicePixelRatio})",
    );
    return (
      g.result +
      '\n# ширина картинки = innerWidth * devicePixelRatio; CSS-координаты для zoom/pan = пиксели снимка / devicePixelRatio'
    );
  },
  fit() {
    const s1 = jsonOrThrow(runOrca(['snapshot']));
    const z = refByName(s1.refs, /zoom and view options/i);
    if (!z) throw new Error('не найдена кнопка зума (возможно, не Figma-вкладка активна)');
    jsonOrThrow(runOrca(['click', '--element', '@' + z]));
    sleep(800);
    const s2 = jsonOrThrow(runOrca(['snapshot']));
    const f = refByName(s2.refs, /^Zoom to fit$/i);
    if (!f) throw new Error('в меню зума нет «Zoom to fit»');
    jsonOrThrow(runOrca(['click', '--element', '@' + f]));
    sleep(800);
    return 'zoom-to-fit ok';
  },
  zoom(x, y, ticks) {
    send(`mouse move ${x} ${y}`); // ← обязательно: Figma зумит от реального курсора
    sleep(300);
    evaluate(wheelJs(Number(x), Number(y), Number(ticks), true));
    sleep(500);
    return `zoom ok (${ticks} ticks @ ${x},${y})`;
  },
  pan(x, y, dx, dy) {
    send(`mouse move ${x} ${y}`);
    sleep(300);
    evaluate(panJs(Number(x), Number(y), Number(dx), Number(dy)));
    sleep(500);
    return `pan ok (${dx},${dy} @ ${x},${y})`;
  },
  shot(path) {
    const r = jsonOrThrow(runOrca(['screenshot']));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return 'saved ' + path;
  },
  eval(js) {
    return JSON.stringify(evaluate(js));
  },
  send(cmd) {
    return JSON.stringify(send(cmd));
  },
  press(key) {
    return JSON.stringify(send('press ' + key));
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.error('Команды: ' + Object.keys(commands).join(', '));
  console.error('Пример: node orca-figma.mjs fit && node orca-figma.mjs zoom 390 188 15 && node orca-figma.mjs shot ./sources/screen-1.png');
  process.exit(2);
}
console.log(commands[cmd](...args));
