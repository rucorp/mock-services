© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия A — Ядро: вход, состояние, лимиты — 2026-10-12 (сводный отчёт)

> **База:** `main` @ `05696f3` · версия `0.5.0` · Node v24.21.0 · режим: только чтение.
> **Baseline:** `npm test` зелёный на `05696f3` (core 41/41, tbank PASSED, kassa 141/141, yookassa 227/227, atol 202/202, upstream 11/11, links 57, drift 221/221).
> **Методология:** [`CHECKLIST-audit-party.md`](CHECKLIST-audit-party.md), §4.A [`AUDIT-PREP-2026-10-12.md`](AUDIT-PREP-2026-10-12.md).
> **Исполнение:** партия выполнена тремя под-агентами по непересекающимся диапазонам `packages/core/index.js` (2670 строк) — детальные отчёты:
> [`AUDIT-PARTY-A1a-2026-10-12.md`](AUDIT-PARTY-A1a-2026-10-12.md) (строки 1–546),
> [`AUDIT-PARTY-A1b-2026-10-12.md`](AUDIT-PARTY-A1b-2026-10-12.md) (546–1335),
> [`AUDIT-PARTY-A2-2026-10-12.md`](AUDIT-PARTY-A2-2026-10-12.md) (1335–2670).
> Диапазоны ID: PA-01…PA-24 → A-1a, PA-25…PA-49 → A-1b, PA-50…PA-99 → A-2 (коллизий нет).

## §1. Итог

**30 находок: blocker ×1, major ×2, minor ×18, info ×9.** Каждый диапазон ядра прочитан полностью; все security-утверждения подтверждены прогонами `node -e` / живыми HTTP-пробами на `127.0.0.1:0`.

Ответы на вопросы партии (§4.A AUDIT-PREP):

1. **State-фасад вне контекста запроса:** вне контекста отдаются `activeId`/default (документировано). Обход `admit()`/policy — **да, есть**: все явные-id API рантайма (`exportState/importState/reset/updateCreds/remove`) не авторизуют target → **PA-50 (blocker)**; плюс байпас `public`/`form`-политик через `defaultOwnerToken` — PA-54.
2. **Обход admit()/policy:** PA-50, PA-54, гонка `switchActive` в namespaces — PA-55, `run()` при неуспешном admission — PA-56.
3. **Чужая песочница через retention/sweep/export:** retention вызывается с `rec.state`; обычный sweep сам по себе не переносит state между записями. Но удаление записи во время in-flight ALS-запроса вызывает fallback `stateProxy` на чужой `activeId` и возвращает canary B (§7.2). Явные `export/import/reset` target ломают изоляцию PA-50 (HTTP-пробы в четырёх исходных адаптерах и в добавленном Alfa — §7.4). Export отдаёт весь state, включая notifications; owner-token'ов в нём нет.
4. **tickAll и чужие очереди:** утечки контента нет, но **starvation**: общий флаг `ticking` без await → за проход доставляется максимум одна песочница — **PA-52 (major)**.
5. **Unbounded-рост:** журнал ограничен по count (200), но unknown-ключи обходят byte cap (PA-27, до ~190 МБ); очередь вебхуков без eviction/капа, O(n) тик (PA-28); `rules` сценариев без cap (PA-51); state песочниц при TTL=0 растёт (дубль PD-07). `createLog` не растёт без предела: при Map size >10000 он очищается целиком, но это сбрасывает квоты всех IP — повтор первой квоты после наполнения 10001 уникальными ключами принят (§7.4). `history` ограничен 200 событиями.
6. **safeEqual на не-ASCII:** корректен (байтовое сравнение, fail-closed на NFC/NFD); неточен только docstring о длине — PA-53.
7. **[VERIFY]-закрытие:** MS-08 — закрыт (таблица 28 входов `parseMsOr`: fallback/клампы; остаток: нет max-клампа — PA-30, дубль tbank `parseInt||0` — PF-03); MS-14 — закрыт (ровно 48 бит, 200k id, 0 коллизий; PaymentId монотонный, окна ±10 с перебираемы ~10k запросов, form-страницы без rate-limit); MS-17 — закрыт (prototype pollution НЕ подтверждена: `safeStateSnapshot` + null-proto + defineProperty; 5 форм загрязнения отброшены; остаток — регресс-тест); MS-20 — закрыт (Content-Length не сверяется — PA-05; остальные замечания по HTTP-лимитам уточнены в §7.4); MS-38 — закрыт (ни один из пяти сервисов не передаёт `now` в рантайм, current core:1993; полные следствия — PA-59).

## §2. Сводный реестр находок (полные формулировки и прогоны — в под-отчётах)

> Строки исходного реестра и под-отчётов привязаны к snapshot `05696f3` (2670 строк). Текущий кодовый snapshot — `9d2ee4b` (2750 строк; HEAD `7d7f7e7` отличается только audit-документами). Для актуальных line refs и повторных динамических проверок используйте §7.1–7.4.

| ID | sev | модуль | файл:строка | суть (кратко) | отчёт |
|---|---|---|---|---|---|
| PA-50 | **blocker** | sandbox runtime | историческая база: core:2299-2339, 2269-2285; текущий TTL/ALS путь: core:2192-2195, 2422-2444, 2468-2479 | Явные-id API (`exportState/importState/reset/updateCreds/remove`) не авторизуют target; дополнительно, sweep удаляет rec in-flight запроса и state-фасад падает на чужой `activeId` (HTTP-canary в §7.2). Чтение/перезапись/сброс B подтверждены в четырёх исходных адаптерах и отдельно в Alfa (§7.4); owner-token не предотвращает leak при TTL-гонке | [A2](AUDIT-PARTY-A2-2026-10-12.md) + §7.2/7.4 |
| PA-51 | **major** | scenario registry | historical: core:1419-1522; current: core:1499-1601 | Реестр один на процесс: правило A срабатывает на B, история A содержит orderId B; rules без cap, matchRule линейный. Текущий повторный ALS-прогон: B увидел правило и history (`applied=true`, `visibleRules=1`, `history=1`) | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-52 | **major** | queue + tickAll | historical: core:1016, 2368-2376; current: core:1085-1143, 2448-2456 | Общий флаг `ticking` + tickAll без await → за проход доставляется ≤1 песочница; голодание очередей чужих арендаторов | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-53 | minor | auth | current: core:1617-1644 (`safeEqual`) | docstring неточен по разной длине; Unicode сравнивается байт-в-байт, NFC/NFD не нормализуются (fail-closed); repeated check §7.4 | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-54 | minor | sandbox policy | historical: core:2175-2177, 2200-2204; current: core:2252-2288 | `public`/`form`-политики в owned обходят заданный `MOCK_SANDBOX_TOKEN`; default/owner policy behavior documented in source; based on original HTTP test | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-55 | minor | sandbox manager | current: core:2367-2377 | гонка переключения `activeId` в namespaces | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-56 | minor | sandbox runtime | current: core:2291-2294 | `run()` выполняется при неуспешном admission | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-57 | minor | sandbox persist | historical: core:1954-1972; current: core:2034-2051, 2061-2065 | creds песочниц сохраняются открытым текстом в registry file (`MOCK_SANDBOX_FILE` или `<MOCK_STATE_FILE>.sandboxes.json`), owner-token — только hash; при текущем umask файл был mode 0644 (код mode не задаёт, результат зависит от umask), §7.4 | [A2](AUDIT-PARTY-A2-2026-10-12.md) + §7.4 |
| PA-58 | minor | queue SSRF | current: core:1057-1073, 1103-1104 | `createDeliveryQueue` по умолчанию `blockPrivateHosts=false` (fail-open); hosted defaults адаптеров учитывать отдельно — PF-01 | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-59 | minor | virtual clock | historical core:1913; current core:1993, 2218-2227, 2237, 2276, 2422-2444 + all 5 services | Полные следствия wall-clock: TTL, expired-admit, sweep/retention ts, create-limit window, createdAt; advance +7d dynamic probe in §7.4 | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-60 | info | sandbox runtime | historical: core (times); current: core:1513-1515 | `times:0` превращается в 1 | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-61 | info | legacy | current: core:1771-1882 | legacy-ветка менеджера песочниц (не используется новым runtime) | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-25 | minor | postJson | historical: core:770-772; current: core:781-788 | hostname со скобками IPv6 → `ENOTFOUND`: вебхуки на IPv6-мерчанта пережигают 24 попытки; после снятия скобок mapped-обход §2.1 становится эксплуатируемым | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-26 | minor | SSRF-гард | historical: core:846-874; current: core:865-882, 919-950, 984-1016 | Текущий динамический повтор: guard допускает `ff00::1`, TEST-NET ×3, `2001:db8::1`, `64:ff9b:1::7f00:1`; `::0:1` и decimal `2130706433` блокируются (loopback / WHATWG URL normalization). IPv4-mapped и WKP NAT64 private формы также блокируются (#46); §7.3 содержит harness. Приёмка адресов не доказывает их сетевую достижимость | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) + §7.3 |
| PA-27 | minor | journal | historical core:705-707; current core:671-728 | unknown keys bypass per-entry size guarantee (original probe: 1 002 022 chars); journal retains max 200 entries | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-28 | minor | queue | current core:1057-1152 | Без eviction/капа; O(n) tick; poison без terminal marker (measurement in A1b); plus PA-52 per-sandbox ticker starvation | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-29 | minor | queue | core (prepare) | prepare(+1) + onFailure(+1) → attempts ×2, maxAttempts исчерпывается одной попыткой | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-30 | minor | parseMsOr | historical core:1134-1170; current core:1214-1245 | Нет finite max-клампа: large duration/400-digit env input can yield `Infinity`; Node timers clamp unexpectedly (original `deadlineMs=1e21` → 1 ms). Current configured sandbox cap accepts 3 records with `maxSandboxes:Infinity` (§7.4) | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) + §7.4 |
| PA-31 | info | queue logs | core | полный URL (userinfo/query) в логах очереди без редакции | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-32 | info | parseMsOr | core | `'1h30m'`/`'1e3'` → тихий fallback | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-33 | info | journal | core | `at` записи журнала по wall-clock | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-01 | minor | parseBody | core:267 | битый %-энкод → не пойманный URIError → 500 вместо 400 (живая проба kassa `/admin/action`) | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-02 | minor | redact | historical: core:476, 337-340; current: core:467-498, Alfa:1694-1703 | Утечки form rawBody: `password_confirmation`, `a=1&&password=x`, `token%5F2`; current HTTP-проба добавила `pass%77ord` (decoded body masked, rawBody открыт), §7.4 | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) + §7.4 |
| PA-03 | minor | redact | core:394 | PAN-сканер пропускает Amex (3-префикс) и Bearer<8 | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-04 | minor | redact | core | молчаливая обрезка: массивы >100, глубина >12 → `'[…]'` | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-05 | minor | readBody | core | Content-Length не сверяется с фактическим телом (дополнение MS-20) | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-06 | info | readBody | core | deprecated `aborted` | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-07 | info | escapeHtml | core:284-298 | backtick/`javascript:` не обрабатываются; sink-ов не найдено | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-08 | info | parseBody | core | недокументированное поведение: last-wins, литеральные `key[]`, BOM→{} | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-09 | info | redact | core | fragment `#token=` не редактируется в curl-генераторе | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |

## §3. Покрытие

| Диапазон | Прочитан полностью | Отчёт |
|---|---|---|
| core 1–546 | ✅ | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) §3 |
| core 546–1335 | ✅ | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) §3 |
| core 1335–2670 | ✅ | [A2](AUDIT-PARTY-A2-2026-10-12.md) §3 |

> **Уточнение охвата:** таблица выше относится к исходной базе `05696f3` (2670 строк). В текущем коде `9d2ee4b` файл содержит 2750 строк; полный повторный проход по 1–2750 выполнен и зафиксирован в §7.1.

## §4. Дубли/уже поставленное

`§2.1/§2.2/§2.4` AUDIT-PREP (SSRF-mapped-bypass, entropy, clock) — подтверждены прогонами, новых ID не завели; PA-58 — класс PF-01; PA-30/PF-03 — остаток MS-08; PA-59 — детализация MS-38; PD-02/PD-07 (партия D) — не дублировались; PD-02 примыкает к зоне core (реестр песочниц) — ведётся в партии D.

## §5. Прогоны

Baseline координатора — зелёный (шапка). Прогоны-доказательства каждой под-партии — в её §5 (`node -e` команды + вывод, HTTP-пробы на `127.0.0.1:0`); scratch-доказательные базы: `/tmp/partyA1a-scratch/`, `/tmp/partyA1b-scratch/`.

## §6. Критерии приёмки §4.A

- [x] По каждой из 6 зон — находки `файл:строка` + прогон-доказательство
- [x] `[VERIFY]`-пункты MS-08/MS-14/MS-17/MS-20/MS-38 закрыты (§1 п.7)
- [x] Находка уровня «можно прочитать чужую песочницу» воспроизведена скриптом (PA-50, HTTP-проба)
- [x] Ни одного изменения поведения (read-only; изменения только в audit-документах)

## §7. Повторная проверка актуального ядра и дельты — 2026-10-12

### 7.1. База и полный охват текущего файла

Первичный сводный отчёт выше был подготовлен по `05696f3` и зафиксировал **2670 строк** `packages/core/index.js`. В ходе этой задачи Arena-ветка была на `9d2ee4b` (#47): текущий файл имел **2750 строк**, то есть +80 к диапазону в issue #48 и исходном prep. Между `9d2ee4b` и fast-forward-коммитом `7d7f7e7` изменились только audit-документы; `git diff 9d2ee4b..7d7f7e7 -- packages/core/index.js` пуст. Поэтому фактически проверена актуальная кодовая версия `9d2ee4b`, файл целиком **1–2750**, включая ранее оставшийся диапазон 1976–2499. Повторная проверка выполнена на Node v22.22.3; код и тесты не изменялись. Отчёт уже существовал в `main` после PR #49, поэтому здесь он дополнен, а не создан второй раз.

Текущие ориентиры: `parseBody` 258–271; `redactRawBody` 467–498; `createJournal` 671–728; `postJson` 729–849; SSRF guard 865–1017; delivery queue 1057–1152; duration parser 1214–1242; virtual clock 1275–1390; scenario registry 1499–1601; `safeEqual` 1617–1622 и same-origin 1667–1735; `createSandboxRuntime` 1976–2533; `verifyMerchantWebhook` 2540–2697; `module.exports` 2699–2750.

### 7.2. TTL-sweep гонка во время запроса — расширяет PA-50

Прямой вызов `sweep()` по-прежнему изолирует снимки: retention получает `rec.state` текущей записи. Но это **не** означает, что sweep безопасен для уже выполняющегося запроса. `run()` сохраняет объект записи в ALS (2291–2294); при её удалении `currentRecord()` больше не находит тот же объект и возвращает `sandboxes.get(activeId)` (2192–2195); `stateProxy` затем читает именно эту запись (2468–2479). `sweep()` удаляет истёкшую запись из Map, не завершая её in-flight handler (2422–2444).

Ниже — воспроизводимая HTTP-проба на T-Bank. В persisted registry заранее есть `race-victim` как `activeId` (такое состояние восстанавливается из `activeId`, `restoreRegistry:2122–2125`; например, после смены режима). В пробе у B и временной песочницы нет отдельных merchant creds, поэтому запрос подписан действительным `svc.tokenOf(payload)`. Владельцу контрольной песочницы A достаточно вызвать `/mock/reset` с target `race-ghost`; этот уже подтверждённый PA-50 маршрут создаёт запись без owner-token. Анонимный business admission в неё успешен. Задержка держит handler в ALS дольше TTL; sweep удаляет A, после чего `GetState` отвечает состоянием B.

```js
process.env.MOCK_HOSTED='1'; process.env.MOCK_TENANCY='owned';
process.env.MOCK_SANDBOX_MAX='10'; process.env.MOCK_SANDBOX_TTL_MS='500';
process.env.MOCK_SANDBOX_SWEEP_MS='1000'; process.env.MOCK_SANDBOX_CREATE_LIMIT='0';
process.env.MOCK_STATE_FILE='';
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const http=require('node:http'), core=require('./packages/core');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ttl-race-proof-'));
const file=path.join(dir,'sandboxes.json'), paymentId='PA-RACE-42';
fs.writeFileSync(file,JSON.stringify({activeId:'race-victim',sandboxes:[{
  id:'race-victim',state:{payments:{[paymentId]:{
    paymentId,orderId:'RACE-VICTIM-CANARY',amount:123456,status:'CONFIRMED',statusHistory:[]
  }}},ownerTokenHash:core.hashSecret('victim-owner-token'),expiresAt:0
}]}));
process.env.MOCK_SANDBOX_FILE=file;
const svc=require('./services/tbank-mock/server');
const req=(port,url,method,headers={},body='')=>new Promise((resolve,reject)=>{
  const q=http.request({hostname:'127.0.0.1',port,path:url,method,
    headers:{...headers,...(body?{'content-type':'application/json'}:{})}},r=>{
    let text=''; r.setEncoding('utf8'); r.on('data',x=>text+=x);
    r.on('end',()=>resolve({status:r.statusCode,body:text}));
  }); q.on('error',reject); q.end(body);
});
(async()=>{
  await new Promise(ok=>svc.server.listen(0,'127.0.0.1',ok));
  const port=svc.server.address().port;
  const control=await req(port,'/sandboxes','POST',{},JSON.stringify({id:'race-controller'}));
  const ownerToken=JSON.parse(control.body).ownerToken;
  const reset=await req(port,'/mock/reset','POST',{
    'x-mock-sandbox':'race-controller','x-sandbox-token':ownerToken
  },JSON.stringify({sandbox:'race-ghost'}));
  const ghost=svc.sandboxRuntime.find('race-ghost');
  const admission=svc.sandboxRuntime.admit({
    headers:{'x-mock-sandbox':'race-ghost'},url:'/v2/GetState'
  },'business');
  const payload={TerminalKey:svc.TERMINAL_KEY,PaymentId:paymentId};
  payload.Token=svc.tokenOf(payload);
  const response=await req(port,'/v2/GetState','POST',{
    'x-mock-sandbox':'race-ghost','x-mock-latency':'2500'
  },JSON.stringify(payload));
  console.log(JSON.stringify({controllerStatus:control.status,resetStatus:reset.status,
    ghostOwnerTokenHash:ghost&&ghost.ownerTokenHash,
    admission:{ok:admission.ok,via:admission.via,record:admission.record&&admission.record.id},
    afterDelayedRequest:{status:response.status,
      ghostExists:Boolean(svc.sandboxRuntime.find('race-ghost')),
      activeId:svc.sandboxRuntime.activeId(),
      victimOrderReturned:response.body.includes('RACE-VICTIM-CANARY')}}));
  await new Promise(ok=>svc.server.close(ok)); fs.rmSync(dir,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exitCode=1;});
```

Результат (Node v22.22.3):

```json
{"controllerStatus":201,"resetStatus":200,"ghostOwnerTokenHash":null,
 "admission":{"ok":true,"via":"namespace","record":"race-ghost"},
 "afterDelayedRequest":{"status":200,"ghostExists":false,"activeId":"race-victim",
 "victimOrderReturned":true}}
```

Отдельный owner-token ALS harness подтверждает, что fallback не зависит от пустого owner hash на `race-ghost`: runtime загрузил `activeId=victim`; `tenant-a` создан с owner-token, admit прошёл `via:'owner'`, затем внутри `run()` виртуально истёк и был удалён. `rt.state.canary` вернул `FOREIGN`:

```js
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('./packages/core'); let now=1000;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'als-ttl-owner-'));
const file=path.join(dir,'sandboxes.json');
fs.writeFileSync(file,JSON.stringify({activeId:'victim',sandboxes:[{
  id:'victim',expiresAt:0,ownerTokenHash:core.hashSecret('victim-token'),
  state:{canary:'FOREIGN'}
}]}));
const rt=core.createSandboxRuntime({state:{canary:'DEFAULT'},mode:'owned',sandboxFile:file,
  initialStateFactory:({id})=>({canary:`STATE-${id}`}),now:()=>now,ttlMs:50,log:()=>{}});
const owner=rt.create({id:'tenant-a'}),rec=rt.find('tenant-a');
const admission=rt.admit({headers:{'x-mock-sandbox':'tenant-a',
  'x-sandbox-token':owner.ownerToken},url:'/business'},'business');
rt.run(admission,()=>{now=1060;rt.sweep();console.log(JSON.stringify({ok:admission.ok,
  via:admission.via,ownerHashPresent:Boolean(rec.ownerTokenHash),
  tenantStillExists:Boolean(rt.find('tenant-a')),activeId:rt.activeId(),
  stateCanary:rt.state.canary}));});
fs.rmSync(dir,{recursive:true,force:true});
```

```json
{"ok":true,"via":"owner","ownerHashPresent":true,"tenantStillExists":false,
 "activeId":"victim","stateCanary":"FOREIGN"}
```

Это подтверждённое межпесочничное чтение через lifecycle/state-фасад, а не только удаление записи во время запроса. Эффект тот же, что у PA-50, поэтому отдельный ID/severity не завожу; PA-50 DoD следует дополнить тестом «истечение/удаление admission record во время await должно завершаться fail-closed, без fallback к другому tenant». В HTTP-пробе активный A намеренно был reset-created namespace с `creds:null`; отдельный owner-token harness показывает, что валидный owner admission также не закрепляет state после sweep. Не утверждается, что подпись B с отдельными merchant credentials автоматически подходит A.

### 7.3. SSRF DNS TOCTOU — динамическая доставка воспроизведена

Подтверждено не только чтением двух отдельных DNS-вызовов, но и контролируемым end-to-end прогоном. `assertPublicHost` разрешил имя как `93.184.216.34` (`packages/core/index.js:984–1016`); затем `http.request` в `postJson` (`:781–788`) независимо разрешил то же имя в `127.0.0.1`. Запрос реально дошёл до локального fixture при `blockPrivateHosts:true`. Этот тест использует подмену DNS в одном Node-процессе, а не внешний публичный DNS; он детерминированно доказывает TOCTOU между проверкой и соединением.

```js
const dns=require('node:dns'), http=require('node:http');
const core=require('./packages/core');
const originalPromiseLookup=dns.promises.lookup, originalLookup=dns.lookup;
let guardLookups=0, connectLookups=0, deliveredToLocal=false;
(async()=>{
  const server=http.createServer((req,res)=>{
    req.resume(); req.on('end',()=>{deliveredToLocal=true;res.end('OK');});
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  dns.promises.lookup=async(host,options)=>host==='rebind.audit.test'
    ? (guardLookups++,[{address:'93.184.216.34',family:4}])
    : originalPromiseLookup(host,options);
  dns.lookup=function(host,options,callback){
    if(typeof options==='function'){callback=options;options={};}
    if(host==='rebind.audit.test'){
      connectLookups++; const ip={address:'127.0.0.1',family:4};
      return process.nextTick(()=>options&&options.all
        ? callback(null,[ip]) : callback(null,ip.address,ip.family));
    }
    return originalLookup.call(dns,host,options,callback);
  };
  const entries={probe:{attempts:0,nextAttemptAt:0,
    url:`http://rebind.audit.test:${server.address().port}/hook`}};
  const queue=core.createDeliveryQueue({entries,retryMs:1000,maxAttempts:1,
    request:e=>({url:e.url,data:{audit:true}}),onSuccess:e=>{e.done=true;},
    onFailure:(e,s)=>{e.failure=s;},blockPrivateHosts:true,
    awaitSequential:true,log:()=>{}});
  await queue.tick();
  console.log(JSON.stringify({guardLookups,connectLookups,deliveredToLocal,
    body:entries.probe.lastBody,done:entries.probe.done}));
  dns.promises.lookup=originalPromiseLookup; dns.lookup=originalLookup;
  await new Promise(ok=>server.close(ok));
})().catch(e=>{dns.promises.lookup=originalPromiseLookup;
  dns.lookup=originalLookup; console.error(e);process.exitCode=1;});
```

```json
{"guardLookups":1,"connectLookups":1,"deliveredToLocal":true,"body":"OK","done":true}
```

Повторная классификация литеральных адресов актуального guard (PA-26, MS-09):

```js
const core=require('./packages/core');
const ips=['ff00::1','::0:1','2130706433','192.0.2.1','198.51.100.2',
  '203.0.113.3','2001:db8::1','64:ff9b:1::7f00:1','::ffff:7f00:1',
  '::ffff:a9fe:a9fe','64:ff9b::7f00:1'];
(async()=>{for(const ip of ips){
  const url=ip.includes(':')?`http://[${ip}]/`:`http://${ip}/`;
  try{await core.assertPublicHost(url);console.log(`${ip}: allowed`);}
  catch(e){console.log(`${ip}: blocked (${e.code})`);}
}})();
```

```text
ff00::1: allowed
::0:1: blocked (SSRF_BLOCKED)
2130706433: blocked (SSRF_BLOCKED)
192.0.2.1: allowed
198.51.100.2: allowed
203.0.113.3: allowed
2001:db8::1: allowed
64:ff9b:1::7f00:1: allowed
::ffff:7f00:1: blocked (SSRF_BLOCKED)
::ffff:a9fe:a9fe: blocked (SSRF_BLOCKED)
64:ff9b::7f00:1: blocked (SSRF_BLOCKED)
```

Проверка вызвала только guard для литеральных IP и не пыталась подключаться к ним: это подтверждает классификацию/разрешение, а не сетевую достижимость. Две прежние формулировки уточнены: `::0:1` — loopback и блокируется; decimal IPv4 блокируется после WHATWG-нормализации URL. Остаются пропуски multicast, TEST-NET, документационного IPv6 и local-use NAT64 диапазона.

Это уточняет MS-09/PA-25: формулировка подотчёта A1b «end-to-end rebinding не воспроизводится» неверна для контролируемого resolver harness. Тест не присваивает новый ID, потому что проблема — существующий MS-09 TOCTOU. Сервисы передают параметр `blockPrivateHosts`; фактические defaults нужно учитывать отдельно (в частности, PF-01 для Kassa).

### 7.4. Повторная проверка `[VERIFY]` и ключевых критериев

| пункт | Доказательство на текущем коде | Статус / остаток |
|---|---|---|
| MS-08 | `node`: `parseMsOr('9'.repeat(400),123) === Infinity`; при `maxSandboxes: Infinity` runtime принял 3 записи. Пустая/мусорная строка даёт fallback, `0` сохраняет семантику отключения. См. `packages/core/index.js:1214–1245,2230–2245`. | `[VERIFY]` закрыт; **max-кламп остаётся** (PA-30), не менять parse/config в этой read-only партии. |
| MS-14 | `generateSandboxId` = 8 бит словаря + 40 случайных бит = 48; T-Bank form URL с известным `PaymentId` вернул HTTP 200 и canary без owner-token. См. `core:1818–1822,2252–2288`, `services/tbank-mock/server.js:1965–2001,2481–2485`. | `[VERIFY]` закрыт; недостающая entropy/capability защита и rate-limit остаются задачей, не доказан перебор неизвестного sandbox-id. |
| MS-17 | JSON own-ключ `__proto__` отвергается `safeStateSnapshot` при import; form `__proto__[polluted]` остаётся буквальным ключом; `Object.prototype.polluted === undefined`. Проверены `constructor`/`prototype`. См. `core:55–180,258–271,447`. | `[VERIFY]` закрыт как «нет pollution»; регрессионный тест остаётся предложением MS-17/brief, тесты не менялись. |
| MS-20 | На Node 22.22.3 `server.maxHeadersCount === null` (свойство есть), `http.maxHeaderSize=16384`, таймауты 60000/300000/5000 мс; raw HTTP с 2106 header-pairs отдал обработчику 1000 пар. В `services/*/server.js` явных override таймаутов нет. | `[VERIFY]` закрыт; уточнение прежнего утверждения «`maxHeadersCount` не существует»: default `null` не означает отсутствие parser default. PA-05 (`Content-Length`) остаётся отдельным остатком. |
| MS-38 | T-Bank runtime создал запись с TTL 60 с; `clock.advance('7d')` сделал virtualNow больше `expiresAt`, но `sweep()` вернул `expired:0`, запись осталась. `createSandboxRuntime` получает default `now:()=>Date.now()` (`core:1993`); ни один из пяти сервисов (Alfa, ATOL, Kassa, T-Bank, YooKassa) не передаёт `now` в runtime (`alfa:226-243`, `atol:220-237`, `kassa:214-231`, `tbank:196-213`, `yookassa:152-169`). | `[VERIFY]` закрыт: TTL/sweep живут в wall-clock; исправление требует отдельного изменения кода/тестов. |
| PA-57 | С `sandboxFile` runtime-created credentials видны в JSON registry; owner-token не записывается в открытом виде, хранится его SHA-256. Текущая проба прочитала file mode 0644 при sandbox umask; `writeFileSync` не задаёт mode (`core:2034-2051,2061-2065`). | Credentials остаются plaintext и файл доступен для чтения согласно umask/permissions; не утверждается, что mode всегда 0644/0664. |
| `safeEqual` Unicode | `checkControlAccess` принимает идентичный `é`, `東京`, emoji и combining sequence и отвергает отличающиеся токены; сравнение байтовое, не нормализует NFC/NFD. | Нефункциональной ошибки не найдено; замечание PA-53 относится к формулировке constant-time при разной длине. |

PA-50 был подтверждён по HTTP в четырёх исходных адаптерах до добавления Alfa. Пятый текущий адаптер (#47) проверен отдельно: в owned-mode владелец A через свой owner-token читает, импортирует state и сбрасывает target B, передавая B через query/body, при этом admission остаётся привязан к A.

```js
process.env.MOCK_HOSTED='1'; process.env.MOCK_TENANCY='owned';
process.env.MOCK_SANDBOX_MAX='10'; process.env.MOCK_SANDBOX_TTL_MS='0';
process.env.MOCK_SANDBOX_SWEEP_MS='60000'; process.env.MOCK_SANDBOX_CREATE_LIMIT='0';
process.env.MOCK_STATE_FILE='';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),core=require('./packages/core');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alfa-pa50-'));
const file=path.join(dir,'sandboxes.json');
fs.writeFileSync(file,JSON.stringify({activeId:'victim-b',sandboxes:[{
  id:'victim-b',expiresAt:0,ownerTokenHash:core.hashSecret('victim-owner-token'),
  creds:{userName:'victim',password:'synthetic'},
  state:{orders:{},payments:{},callbacks:{},canary:'ALFA-VICTIM-CANARY'}
}]}));
process.env.MOCK_SANDBOX_FILE=file;
const svc=require('./services/alfa-mock/server');
const request=(port,url,method,headers={},body='')=>new Promise((resolve,reject)=>{
  const q=http.request({hostname:'127.0.0.1',port,path:url,method,
    headers:{...headers,...(body?{'content-type':'application/json'}:{})}},r=>{
    let text='';r.setEncoding('utf8');r.on('data',x=>text+=x);
    r.on('end',()=>resolve({status:r.statusCode,body:text}));
  });q.on('error',reject);q.end(body);
});
(async()=>{try{
  await new Promise(ok=>svc.server.listen(0,'127.0.0.1',ok));
  const port=svc.server.address().port;
  const created=await request(port,'/sandboxes','POST',{},JSON.stringify({id:'tenant-a'}));
  const auth={'x-mock-sandbox':'tenant-a','x-sandbox-token':JSON.parse(created.body).ownerToken};
  const read=await request(port,'/mock/state?sandbox=victim-b','GET',auth);
  const write=await request(port,'/mock/state','POST',auth,
    JSON.stringify({sandbox:'victim-b',state:{canary:'ALFA-WRITTEN-CANARY'}}));
  const afterWrite=await request(port,'/mock/state?sandbox=victim-b','GET',auth);
  const reset=await request(port,'/mock/reset','POST',auth,JSON.stringify({sandbox:'victim-b'}));
  const resetState=svc.sandboxRuntime.find('victim-b').state;
  console.log(JSON.stringify({createStatus:created.status,readStatus:read.status,
    readForeignCanary:read.body.includes('ALFA-VICTIM-CANARY'),writeStatus:write.status,
    writeResult:JSON.parse(write.body),afterWriteContains:afterWrite.body.includes('ALFA-WRITTEN-CANARY'),
    resetStatus:reset.status,resetResult:JSON.parse(reset.body),
    resetClearedCanary:!Object.hasOwn(resetState,'canary')}));
}finally{
  await new Promise(ok=>svc.server.listening?svc.server.close(ok):ok());
  fs.rmSync(dir,{recursive:true,force:true});
}})().catch(e=>{console.error(e);process.exitCode=1;});
```

```json
{"createStatus":201,"readStatus":200,"readForeignCanary":true,"writeStatus":200,
 "writeResult":{"ok":true,"sandbox":"victim-b"},"afterWriteContains":true,
 "resetStatus":200,"resetResult":{"ok":true,"sandbox":"victim-b","current":"tenant-a"},
 "resetClearedCanary":true}
```

PA-57 proof against the current runtime:

```js
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('./packages/core'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa57-'));
const file=path.join(dir,'sandboxes.json');
const rt=core.createSandboxRuntime({state:{},mode:'owned',sandboxFile:file,log:()=>{}});
const created=rt.create({id:'proof',creds:{terminalPassword:'synthetic-creds-PA57'},owner:true});
const raw=fs.readFileSync(file,'utf8'),stored=JSON.parse(raw).sandboxes.find(x=>x.id==='proof');
console.log(JSON.stringify({fileMode:(fs.statSync(file).mode&0o777).toString(8),
  credsPlaintext:raw.includes('synthetic-creds-PA57'),
  ownerTokenStoredPlaintext:raw.includes(created.ownerToken),
  ownerTokenHashMatches:stored.ownerTokenHash===core.hashSecret(created.ownerToken)}));
fs.rmSync(dir,{recursive:true,force:true});
```

```json
{"fileMode":"644","credsPlaintext":true,"ownerTokenStoredPlaintext":false,"ownerTokenHashMatches":true}
```

**Прочие критерии шести зон — current line refs:** `createLog` (`core:2218-2227`) ограничен, но при `size>10000` очищается весь Map; сценарные `rules` (`1499-1519`) не имеют cap, а `matchRule` (`1522-1544`) проходит их линейно; `createJournal` (`671-728`) ограничивает count=200, но unknown-keys обходят byte cap (PA-27); `tickAll` (`2448-2456`) не ждёт callbacks, тогда как queue держит общий `ticking` (`1085-1143`) — PA-52 starvation. Динамические cross-ALS и `tickAll` проверки даны в [A2](AUDIT-PARTY-A2-2026-10-12.md) §2/§5; предыдущая HTTP-проба T-Bank подтвердила, что owner A получил journal marker B (PA-50).

`createLog` bounds-vs-quota regression воспроизведён отдельной командой (core current `2218-2227`):

```js
const c=require('./packages/core');
const rt=c.createSandboxRuntime({state:{},initialStateFactory:()=>({}),mode:'namespaces',
  maxSandboxes:12000,createLimit:1,log:()=>{}});
for(let i=0;i<10001;i++)rt.create({id:`ip-${i}`,ip:`source-${i}`});
const repeat=rt.create({id:'same-source-second-create',ip:'source-0'});
console.log({records:rt.stats().count,repeatAccepted:Boolean(repeat),limit:1});
```

```json
{"records":10002,"repeatAccepted":true,"limit":1}
```

То есть `createLog` не безграничен по памяти, но all-or-nothing clear обнуляет квоты; это остаток MS-13, не новая отдельная задача в read-only отчёте.

Дополнительная HTTP-проверка PA-02: form-urlencoded `pass%77ord=synthetic-form-secret-77` декодируется в `body.password` (поле в `summarizeBody` маскируется), но `rawBody` в `/admin/journal` сохраняет значение без маскировки. Проба на Alfa (`POST /payment/rest/register.do`, затем `GET /admin/journal`) дала оба ответа HTTP 200, `errorCode=0`, `decodedPasswordMasked=true`, `rawBodyStillContainsSecret=true`; тело: `userName=[REDACTED]&pass%77ord=synthetic-form-secret-77&...`. Это ещё один percent-encoded key-вариант известной PA-02, новый ID не завожу.

### 7.5. Прогоны и ограничения повторной проверки

Baseline `npm test` на коде `9d2ee4b` до audit-документов был зелёным (`/tmp/mock-services-npm-test-before.log`). После содержательных изменений Party A report `npm test` завершился с exit 0: core 48/48, Kassa 141/141, YooKassa 227/227, ATOL 202/202, Alfa 287/287, upstream 11/11, links 69 файлов без ошибок, drift 316/316; T-Bank `SELFTEST PASSED`. Полный лог — `/tmp/mock-services-npm-test-final.log`; после редакционного уточнения пути повторён `npm run check:links`: 69 файлов, битых ссылок нет.

Выполнены ровно 20 **последовательных** запусков `npm run test:yookassa` (Node v22.22.3, без параллелизма): **16 PASS / 4 FAIL**. Падали №3, №7, №17, №18, каждый раз только `services/yookassa-mock/selftest.js:412` — `уведомление done после ACK 200` (226 passed, 1 failed). В неуспешных логах webhook delivery/ACK завершался сразу после этой assertion; остальные 16 запусков — 227 passed, 0 failed. Итого требование проверить 20 запусков выполнено, но стабильность теста **не подтверждена**; это follow-up владельцу, не исправлялось из-за read-only scope. Полные логи — `/tmp/mock-services-test-yookassa-partyA-1.log` … `-20.log`.

Изменения остаются только в audit-документах; исполняемый код, selftest'ы, compose и CI не менялись.
