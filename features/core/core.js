'use strict';
// Core bootstrap: engine bindings, EV tables, analytics, changelog, settings + storage, resume, owner helpers.
  var G = window.General;
  var EV = window.GeneralEV;
  var X = window.GeneralExp;   // experimental ruleset (single-column Генерал; separate flow)
  // load the precomputed optimal-value table (powers hints, luck/skill, bots)
  var evReady = false;
  try {
    if (EV && window.GeneralEVTable) { EV.setTable(window.GeneralEVTable.V); evReady = true; }
  } catch (e) { evReady = false; }
  // a second engine bound to the experimental ruleset (free-column EV: deviation
  // scoring + два чифта). Powers the experimental EV bot and skill/luck analysis.
  var EVX = null, evxReady = false;
  try {
    if (EV && EV.create) {
      EVX = EV.create({
        DICE_COUNT: G.DICE_COUNT, MAX_ROLLS: G.MAX_ROLLS,
        CATEGORIES: G.CATEGORIES_EXP, scoreFor: G.scoreForExp,
        aiChooseHolds: G.aiChooseHolds,
        aiChooseCategory: function (p, dice) {
          var best = null, bv = -Infinity;
          G.CATEGORIES_EXP.forEach(function (c) { if (typeof p.scores[c.key] === 'number') return; var v = G.scoreForExp(c.key, dice); if (v > bv) { bv = v; best = c.key; } });
          return { category: best, value: bv };
        },
      });
      if (window.GeneralEVTableExp) { EVX.setTable(window.GeneralEVTableExp.V); evxReady = true; }
    }
  } catch (e) { evxReady = false; }
  // EXACT penalty-aware value table V*(mask, upper-subtotal) — decoded async from the
  // gzipped+base64 asset. Powers the truly-optimal experimental bot + skill/luck.
  var exactExp = null, exactReady = false, EXP_UPPER_BITS = 0;
  if (X && EVX) { for (var ei = 0; ei < EVX.NCAT; ei++) if (G.UPPER_KEYS.indexOf(EVX.CATS[ei].key) >= 0) EXP_UPPER_BITS |= (1 << ei); }
  function expUpperComplete(mask) { return (mask & EXP_UPPER_BITS) === EXP_UPPER_BITS; }
  function vstarExp(mask, up) {
    if (expUpperComplete(mask)) return EVX.vstar(mask);          // penalty already realised → lower-only optimal
    var rec = exactExp && exactExp[mask]; if (!rec) return EVX.vstar(mask);
    var i = up - rec.lo; if (i < 0) i = 0; else if (i >= rec.arr.length) i = rec.arr.length - 1;
    return rec.arr[i];
  }
  (function decodeExactExp() {
    if (!window.GeneralEVExactExp || !EVX || typeof DecompressionStream === 'undefined') return;
    try {
      var bin = Uint8Array.from(atob(window.GeneralEVExactExp.gz), function (c) { return c.charCodeAt(0); });
      new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer().then(function (ab) {
        var dv = new DataView(ab), o = 0, count = dv.getUint32(o, true); o += 4;
        var scale = dv.getUint16(o, true); o += 4;                // skip scale's pair + ncat
        var table = {};
        for (var i = 0; i < count; i++) {
          var mask = dv.getUint32(o, true); o += 4;
          var lo = dv.getInt16(o, true); o += 2;
          var len = dv.getUint16(o, true); o += 2;
          var arr = new Float32Array(len), prev = 0;
          for (var t = 0; t < len; t++) { prev += dv.getInt16(o, true); o += 2; arr[t] = prev / scale; }
          table[mask] = { lo: lo, arr: arr };
        }
        exactExp = table; exactReady = true;
      }).catch(function () { exactReady = false; });
    } catch (e) { exactReady = false; }
  })();
  var $ = function (id) { return document.getElementById(id); };
  // ---- analytics (GoatCounter custom events; cookieless, no personal data) ----
  // page visits (city/country/OS/browser) are counted automatically by count.js;
  // these helpers fire the named game events. Always best-effort — never throws.
  // Events fired before the async count.js has loaded are QUEUED and flushed once it's ready,
  // so early network events (host/join/code) aren't dropped on a slow (mobile) connection.
  var _gcQueue = [];
  function _gcSend(name) { window.goatcounter.count({ path: name, title: name, event: true }); }
  function track(name) {
    try {
      if (window.goatcounter && window.goatcounter.count) _gcSend(name);
      else { _gcQueue.push(name); if (_gcQueue.length > 50) _gcQueue.shift(); }
    } catch (e) {}
  }
  (function gcFlush(n) {
    try {
      if (window.goatcounter && window.goatcounter.count) { while (_gcQueue.length) { try { _gcSend(_gcQueue[0]); } catch (e) {} _gcQueue.shift(); } return; }
    } catch (e) {}
    if (n < 150) setTimeout(function () { gcFlush(n + 1); }, 200);   // poll up to ~30s for count.js to load
  })(0);
  // one game lifecycle event ('start' | 'finish' | 'abort' | 'error'), tagged net/local + manual/regular;
  // a finished game also reports this device's dice-flavour (keep-vs-throw, order-vs-separate)
  function trackGame(kind) {
    var p = (netMode ? 'net' : 'local') + '-' + (manualMode ? 'manual' : 'regular');
    track(p + '-' + kind);
    if (kind === 'finish') {
      track(settings.selectKeep ? 'finish-keep' : 'finish-throw');
      track(settings.newDiceBatch ? 'finish-order' : 'finish-separate');
    }
  }
  // app version (major.minor.micro) — bump on every change; shown as vX.Y.Z in settings
  var APP_VERSION = '1.51.3';
  // changelog (newest first) — surfaced by tapping the version marker on the start-screen settings.
  // tags: new (ново) · chg (промяна) · fix (поправка) · rem (премахнато)
  var CHANGELOG = [
    { v: '1.51.3', items: [
      ['chg', 'Мрежова игра: при връщане към приложението (напр. след преглед на друг таб на iPhone) състоянието се синхронизира наново — старшината разпраща текущото състояние, гост моли да го наваксат, за да не се губят ходове.'] ] },
    { v: '1.51.2', items: [
      ['new', 'Меню на старшината: освен „AI“, отпаднал боец вече може да се сложи на „Пауза“ — прескача се и не бави края; ако се върне навреме, паузата се сваля и той наваксва пропуснатите ходове.'] ] },
    { v: '1.51.1', items: [
      ['chg', 'QR кодът за покана вече е връзка — сканира се и с камерата на телефона (извън приложението) и отваря играта направо в режим за присъединяване с готов код.'] ] },
    { v: '1.51.0', items: [
      ['chg', 'Мрежова игра: разпаднал се боец вече не се прескача безвъзвратно — играта изчаква да се върне (или го поеми с AI от менюто), вместо да приключи и да го остави недовършен.'],
      ['new', 'Възстановяване при срив на старшината: ако старшината презареди/затвори, при влизане се предлага „възстанови играта“ — възстановява последното състояние, а гостите се връщат по същия код.'] ] },
    { v: '1.50.10', items: [
      ['fix', 'Мрежова игра „с минуси“: твоите ходове вече се записват, така че финалното обобщение е пълно — записите на играчите се отварят, а не само разделът с категориите.'] ] },
    { v: '1.50.9', items: [
      ['new', 'Плъзгане за избор: задръж и плъзни по заровете, за да маркираш няколко наведнъж (важи и за двата режима, на устройство и по мрежа). Единично докосване пак превключва един зар.'] ] },
    { v: '1.50.8', items: [
      ['new', 'Режим „избери кои да държиш“: бутон „↻ Хвърли всички“ над заровете хвърля наново всичките пет наведнъж.'] ] },
    { v: '1.50.7', items: [
      ['new', 'Статистика „Дръж / хвърли“: под всеки зар вече се вижда и какъв дял изхвърляш (червено), освен какъв дял задържаш (зелено).'] ] },
    { v: '1.50.6', items: [
      ['chg', 'Зар-иконите в статистиките за задържане вече са като заровете от листа с комбинации (светли с тъмни точки).'] ] },
    { v: '1.50.5', items: [
      ['chg', 'Бутонът за записване на комбинация вече казва „ИЗБЕРИ КОМБИНАЦИЯ!“.'],
      ['fix', 'Игра с минуси: бутонът за хвърляне вече се оцветява правилно след мрежова игра (вече не остава като бутона „избери зарове“).'] ] },
    { v: '1.50.4', items: [
      ['chg', 'Статистика „Запис на хвърляне“: заровете са центрирани спрямо най-дългия ред (три зара), а процентите се подравняват.'] ] },
    { v: '1.50.3', items: [
      ['fix', 'Зар-иконите в статистиките за задържане отново имат рамка (контур на зар).'] ] },
    { v: '1.50.2', items: [
      ['chg', 'Статистики за задържане: зар-иконите вече са квадратни; „Запис на хвърляне“ показва хвърлянето с брой зарове (един/два/три) вместо думи; двете нови метрики имат обяснения при докосване.'] ] },
    { v: '1.50.1', items: [
      ['fix', 'Ход по ход (раздели): заровете се групират по поколение — в реда, в който боецът ги е видял (задържани → нови), а не само задържани/нови. По-малките зарове са центрирани спрямо по-големите.'] ] },
    { v: '1.50.0', items: [
      ['new', 'Нови статистики (в обобщението на играта и в досието на стопанина): „Запис на хвърляне“ — на кое хвърляне записваш (първо/второ/трето), и „Какво задържаш“ — процент задържане за всяко число (зар-икона) като мярка за гоненето.'] ] },
    { v: '1.49.5', items: [
      ['chg', 'Ход по ход: задържаните зарове винаги са осветени, а изхвърлените — затъмнени; подреждането следва само твоята настройка „подреди/раздели“. На финалния ред заровете, които правят комбинацията, са малко по-големи.'] ] },
    { v: '1.49.4', items: [
      ['new', 'Статистика: при старт на мрежова игра се отчита и броят живи играчи в лобито (1–5, без AI).'] ] },
    { v: '1.49.3', items: [
      ['chg', 'Наблюдение по мрежа: при записване графата веднага се показва като попълнена (а не само да примигва).'] ] },
    { v: '1.49.2', items: [
      ['fix', 'Статистика: събитията се изчакват, докато се зареди броячът, и не се губят (важно за мрежовите събития при бавна връзка).'] ] },
    { v: '1.49.1', items: [
      ['fix', 'Ход по ход: редовете отново са като преди (без стрелки и разместване); докосване сгъва/разгъва само реда със заровете, а първият ход е разгънат по подразбиране.'] ] },
    { v: '1.49.0', items: [
      ['new', 'Ход по ход (край на игра и архив): всеки ход се разгъва при докосване и показва хвърлянията/презахвърлянията; заровете следват избора „задръж/хвърли“ и подреждането „подреди/раздели“.'] ] },
    { v: '1.48.8', items: [
      ['new', 'Мрежова игра: ако презаредиш по време на игра, до 15 минути приложението предлага да се върнеш в нея (по запазения код); по-стари игри се чистят автоматично.'] ] },
    { v: '1.48.7', items: [
      ['fix', 'Наблюдение по мрежа: „Към текущия играч“ вече винаги връща екрана на активния играч (дори преди той да е хвърлил).'],
      ['chg', 'Зареждане на QR: вместо бял квадрат с въртележка сега се показва само анимация върху фона на изгледа.'] ] },
    { v: '1.48.6', items: [
      ['fix', 'Мрежова игра „с минуси“: отрицателните точки (горен ред) вече се предават правилно — другото устройство вече не показва огромни погрешни стойности.'] ] },
    { v: '1.48.5', items: [
      ['chg', 'Чашката за кафе вече е точно в средата на екрана, а двата етикета са от двете ѝ страни.'] ] },
    { v: '1.48.4', items: [
      ['chg', 'Бутонът за кафе вече е малка чашка по средата между „на устройството“ и „по мрежа“; плъзгане по целия ред пак сменя избора, а докосване на чашката отваря почерпката.'] ] },
    { v: '1.48.3', items: [
      ['chg', 'QR прозорец: при копиране адресът за кратко се сменя с „копирано!“ (докато трае зеленото просветване).'] ] },
    { v: '1.48.2', items: [
      ['fix', 'Заглавието: разстоянието около QR-буквата „Е" е изравнено с останалите букви.'],
      ['chg', 'QR прозорец: адресът отдолу не се маркира — докосни го, за да го копираш (светва зелено).'] ] },
    { v: '1.48.1', items: [
      ['chg', 'Заглавието: QR-буквата „Е" вече е точно толкова висока, колкото останалите букви; текстът на QR прозореца е „Сподели с приятел“.'] ] },
    { v: '1.48.0', items: [
      ['new', 'Буквата „Е" в заглавието е нарисувана като QR-знак — докосни я и изскача QR код към играта, който приятел може да сканира, за да я отвори.'] ] },
    { v: '1.47.5', items: [
      ['new', 'Анонимна статистика (GoatCounter, без бисквитки): посещения и събития за игрите — старт/край/отказ, мрежови грешки, хостване/присъединяване, въвеждане на код, прекъсване/възстановяване, изнасяне/внасяне.'] ] },
    { v: '1.47.4', items: [
      ['new', 'Начален екран: бутон с чаша кафе над „Настройки“ — отваря профила за почерпка (Buy Me a Coffee) в нов раздел.'] ] },
    { v: '1.47.3', items: [
      ['chg', 'Присъединяване: бутонът „Постави“ приема и целия споделен текст от старшината (а не само голия код) — извлича кода от него.'] ] },
    { v: '1.47.2', items: [
      ['chg', 'Присъединяване: бутонът „Постави“ проверява клипборда — приема само код от точно 6 букви и цифри, иначе показва, че копираният код не е правилен.'] ] },
    { v: '1.47.1', items: [
      ['fix', 'Игра с минуси: записаните минус-точки на горния ред са с по-наситен, по-тъмночервен оттенък — вече се четат по-лесно.'] ] },
    { v: '1.47.0', items: [
      ['chg', 'Наблюдение по мрежа: между всяко действие на боеца (първи хвърл, преподреждане, записване) има пауза от ~2,5 сек, за да се проследи ходът.'],
      ['new', 'Наблюдение: новохвърлените зарове и избраната графа примигват за половин секунда.'],
      ['chg', 'Наблюдение: възможните комбинации с текущите зарове се показват и се обновяват при всяко преподреждане; новите зарове се подреждат според предпочитанието на наблюдателя (раздели/подреди).'] ] },
    { v: '1.46.0', items: [
      ['chg', 'Мрежа: бутоните са „ПОКАНИ“ / „ПРИСЪЕДИНИ СЕ“; добавен бутон „Назад“; в изгледа за присъединяване — поставяне (ляво) и камера (дясно) с нови икони.'],
      ['chg', 'Заглавия с нарисувани икони: „Правила“ (книга), „Военен архив“, „Настройки“ (зъбчато колело), „Изчисти архива“ (кошче) — без емоджита.'],
      ['chg', 'Картон на боеца: при пропуснат старшина селекторът за пол отново става активен.'],
      ['chg', 'Дръжката за подреждане: по-широки колони и по-стегнати редове на точките.'] ] },
    { v: '1.45.0', items: [
      ['new', 'Хост по мрежа: бутон „Сподели“ до копирането — отваря системния диалог за споделяне (напр. през Съобщения на iOS), за да пратиш кода направо.'] ] },
    { v: '1.44.0', items: [
      ['chg', 'Досие на стопанина: графиките точки/умение/късмет се избират една по една (само избраната се показва); всяка с заглавие „… последните X игри“ и номера на игрите по оста с етикет „игра“.'],
      ['chg', 'Средните по много игри броят и мрежовите игри за съответните правила (точките се водят дори без записани ходове).'] ] },
    { v: '1.43.0', items: [
      ['chg', 'Плъзгания (без бутона за старт): не заключват вертикалния скрол; четат движението по X до вдигане на пръста и действат при вдигане според крайното разместване.'] ] },
    { v: '1.42.1', items: [
      ['chg', 'Картон на боеца: при заключено име на старшината селекторът за пол е изключен и с приглушени цветове.'] ] },
    { v: '1.42.0', items: [
      ['chg', 'Картон на боеца: при пропуснат старшина AI ключът на неговото място вече се включва.'],
      ['chg', 'Мрежов изглед: иконата на заглавието е центрирана; по-плътни икони за камера/поставяне; при поставяне светват зелено бутонът и кодовото поле, при сканиране — само полето (без долната бележка).'],
      ['fix', 'Мрежа: отказ от хост/гост вече не показва селектора за тип игра (той идва от началния екран).'] ] },
    { v: '1.41.0', items: [
      ['fix', 'Мрежа: всеки ход се пренася с пълните данни (зарове/решения) до всички устройства — историята вече е пълна за всички играчи, режими и правила (вкл. „с минуси“).'] ] },
    { v: '1.40.3', items: [
      ['fix', 'Архив: кривата на точките се показва и за играчи без записани ходове (взима се от резултатите) — вече се вижда линия за всички.'],
      ['fix', 'Архив: разпознаване на по-стари мрежови игри (без минуси) и по липсващите облози.'] ] },
    { v: '1.40.2', items: [
      ['fix', 'Архив: по-старите мрежови игри (без явен маркер) се разпознават по записа на ходовете — вече не се водят грешно като игри на устройството.'] ] },
    { v: '1.40.1', items: [
      ['fix', 'Селектори с плъзване (правила, устройство/мрежа, архив, пол): посоката се заключва и превключването става чак при вдигане на пръста — без задействане при излизане от кутийката.'] ] },
    { v: '1.40.0', items: [
      ['new', 'Архив: всеки запис показва и иконка дали играта е била на устройството или по мрежа.'],
      ['chg', 'Архив: маркерите (зар/молив и устройство/мрежа) са в началото на реда, преди датата/часа.'] ] },
    { v: '1.39.0', items: [
      ['new', 'Картон на боеца: полът се сменя и с плъзване настрани (една стъпка по посока на плъзгането); свайпът за махане не се задейства върху селектора за пол.'] ] },
    { v: '1.38.1', items: [
      ['chg', 'Архив: правилата (с/без минуси) се избират със същия подчертан селектор като на началния екран (с докосване или плъзване).'] ] },
    { v: '1.38.0', items: [
      ['chg', 'Картон на боеца: знакът на старшината слезе на долния ред, вдясно до AI ключа (където беше ✕); AI ключът на старшината е изключен (винаги човек).'] ] },
    { v: '1.37.1', items: [
      ['chg', 'Плъзгането на бутона за старт също заключва вертикалния скрол, докато трае.'] ] },
    { v: '1.37.0', items: [
      ['rem', 'Настройки: „Нови зарове“ махнато (живее при стопанина/звездата и в „?“ бутона); „Облози“ вече не се показва по време на игра.'] ] },
    { v: '1.36.0', items: [
      ['chg', 'Бутон за старт: златното петно следва пръста при плъзгане (в границите на бутона) и щрака към най-близкия край при пускане.'] ] },
    { v: '1.35.4', items: [
      ['fix', 'Свайп за махане на боец заключва вертикалния скрол, докато трае плъзгането.'] ] },
    { v: '1.35.3', items: [
      ['chg', 'Смяната на режим (зарове/отчет) също показва кратко обяснение долу.'] ] },
    { v: '1.35.2', items: [
      ['chg', 'Повече разстояние между селектора устройство/мрежа и долния край на екрана.'] ] },
    { v: '1.35.1', items: [
      ['fix', 'Бутон за старт: вече само златното петно се плъзга (тъмното стои); анимацията при свеж старт се вижда на всяко зареждане.'] ] },
    { v: '1.35.0', items: [
      ['chg', 'Мрежов изглед: „Игра по мрежа“ с нарисувана икона за мрежа; бутоните са „НАПРАВИ“ и „ВЛЕЗ“ без емоджита.'],
      ['chg', 'Бутон за старт: при смяна на режим само светлият градиент се движи — тъмният стои на място.'],
      ['chg', 'Мрежа: докосване извън панела го затваря само на избора хост/гост; докато правиш или влизаш в игра, не се затваря (без случайни откази).'] ] },
    { v: '1.34.0', items: [
      ['new', 'Мрежа: ако старшината откаже лобито, гостите получават съобщение и се връщат към избора хост/гост.'],
      ['fix', 'Мрежа: смяна на фокуса (напр. клавиатурата) вече не разваля изгледа на хост/гост работния поток.'] ] },
    { v: '1.33.0', items: [
      ['chg', 'Добавянето на боец скролва надолу, така че новата карта и бутонът „+“ остават видими.'],
      ['chg', 'Подреждане: дръжката вече не светва; маркерът на влачената карта се рисува навътре, за да не застъпва съседа.'],
      ['new', 'Селекторите (правила и устройство/мрежа) се превключват и с плъзване настрани.'] ] },
    { v: '1.32.0', items: [
      ['new', 'Смяната на правила или устройство/мрежа показва кратко обяснение долу (5 сек) — старите бележки в долния панел паднаха.'],
      ['chg', 'Хост: докосване на кода го оцветява зелено (като копчето за копиране).'],
      ['chg', 'Меню в игра: „Начало“ е най-горе и пита за потвърждение; „Правила“ и „Комбинации“ са иконки над „Назад“; без емоджи на „Настройки“.'],
      ['chg', 'Край на играта: бутонът за нова игра е „НАЧАЛО“.'] ] },
    { v: '1.31.0', items: [
      ['new', 'Бутон за старт: при свеж старт (веднъж на сесия) леко се поклаща, а при превключване на режим градиентът се „разлива“ в посоката на плъзгане.'],
      ['chg', 'Бутон за старт: докосване на активния край също стартира играта; докосване на неактивния край сменя режима.'],
      ['fix', 'Мрежа: класирането в края показва кривата на точките за всички играчи, не само за локалния.'],
      ['chg', 'Хост по мрежа: докато QR кодът се зарежда, се върти индикатор за зареждане.'] ] },
    { v: '1.30.3', items: [
      ['chg', 'Селекторите (правила и устройство/мрежа): неактивната опция вече е със същия размер, само приглушена — без смаляване.'] ] },
    { v: '1.30.2', items: [
      ['chg', 'Режим за разработчици: вече не се появява допълнителна иконка — след отключване самото заглавие „ГЕНЕРАЛ“ става докосваемо и го отваря.'] ] },
    { v: '1.30.1', items: [
      ['chg', 'Бутонът за настройки се премести между „Правила“ и „Архив“ в долния панел, със същия вид като тях.'] ] },
    { v: '1.30.0', items: [
      ['chg', 'Начален екран: фиксиран горен ред (заглавие, правила, настройки) и долен панел (правила/архив, БОЙ!, тип игра); списъкът с бойци се скролва, ако не побира.'],
      ['chg', 'Правила и архив са вече малки иконки; типът игра в архива се показва със зар/молив вместо текст.'],
      ['chg', 'Подреждане на бойците: задръж върху дръжката ~0.5 сек, после влачи — местенето е с анимация.'],
      ['chg', 'Старшината не може да се маха, освен ако не е пропуснат; ако се махне, новият пръв боец пази своето, но показва приглушен знак — докосни го, за да върнеш старшината.'],
      ['chg', 'По мрежа: „Откажи“ от поканата връща към избора хост/гост, а не към началото.'],
      ['rem', 'Правилата (с/без минуси) ги няма вече в настройките — избираш ги на началния екран.'] ] },
    { v: '1.29.0', items: [
      ['chg', 'Бутон за добавяне: малък „+" с цвета на картончето на боеца (15% ширина, без рамка).'],
      ['chg', 'Бутоните „Правила" и „Архив" са смалени с 30%.'],
      ['chg', 'Бутон за старт: по-плавни преходи, надписът е само „БОЙ!" в средата между двата градиента.'] ] },
    { v: '1.28.1', items: [
      ['chg', 'Бутон за старт: смален до 70% от ширината.'] ] },
    { v: '1.28.0', items: [
      ['chg', 'Бутон за старт: една цяла повърхност без отделни секции — иконите (зар / молив) стоят в своя цвят, а докосването познава ляво/средата/дясно. Плъзването пак сменя режима.'],
      ['fix', 'Преначертан молив (старият беше счупен); по-широка средна част, за да побере преходите.'] ] },
    { v: '1.27.2', items: [
      ['chg', 'Бутон за старт: повече място за иконите; границата режим↔среда е плавен преход (без твърда черта).'] ] },
    { v: '1.27.0', items: [
      ['chg', 'Бутон за старт: режимите са с икони (зар / молив) — и двата се виждат; превключваш с докосване или плъзване.'],
      ['chg', '„+ БОЕЦ“ е обикновен текст; превключвателите — без изтъняване, само смалени.'],
      ['chg', 'Махане на боец: червеният фон се показва само колкото си плъзнал (без прозиране).'],
      ['new', 'Балонът на старшината се затваря при докосване встрани.'] ] },
    { v: '1.26.2', items: [
      ['chg', 'Начален екран: „Правила“ и „Архив“ са над бутона за старт, изборът „на устройството / по мрежа“ — под него.'] ] },
    { v: '1.26.1', items: [
      ['chg', 'Начален екран: по-изчистени превключватели и бутон за старт (по-фин неактивен текст, по-меки цветове).'] ] },
    { v: '1.26.0', items: [
      ['new', 'Начален екран: плъзни боец наляво, за да го махнеш (червено „МАХНИ" се разкрива; готово при 50%).'] ] },
    { v: '1.25.0', items: [
      ['new', 'Нов бутон за старт: „игра / В БОЙ! / отчет“ — избери режим (докосни страна или плъзни), стартирай от средата.'],
      ['chg', '„С минуси“ е по подразбиране за нови игри; редът на избора е „с минуси · без минуси“.'] ] },
    { v: '1.24.0', items: [
      ['chg', 'Наблюдение по мрежа: ходовете на опонента се показват по-спокойно (2 сек между действията).'],
      ['new', 'Наблюдение: новите зарове на опонента се групират по ТВОИте настройки; виждаш и възможните комбинации.'],
      ['chg', 'Наблюдение: вместо избора на зарове на живо — кратко маркиране кои зарове се хвърлят, после новите.'] ] },
    { v: '1.23.1', items: [
      ['fix', 'Мрежа: ходът на по-бавен играч вече не се рестартира (заровете не се хвърлят пак сами).'] ] },
    { v: '1.23.0', items: [
      ['new', '„С минуси“ по мрежа и на отчет (ръчно вписване) — вече работи, не само със зарове.'] ] },
    { v: '1.22.0', items: [
      ['new', '„С минуси“ по мрежа (със зарове): хостът прави играта, всички играят по неговите правила.'],
      ['fix', 'История: мрежовите игри „с минуси“ се записват с правилния правилник.'],
      ['chg', '„С минуси“ вече се избира и при „по мрежа“.'] ] },
    { v: '1.21.1', items: [
      ['chg', 'В обобщението: „+Xт умение / +Yт късмет“ — за да е ясно, че са точки.'],
      ['new', '„С минуси“: точките на числовата част се натискат — обяснение за −50 при минус.'] ] },
    { v: '1.21.0', items: [
      ['new', 'Маркерът за версия (на началния екран) се натиска и показва този списък с промени.'] ] },
    { v: '1.20.x', items: [
      ['fix', 'История: точките за игри „с минуси“ се смятат правилно (включват −50).'],
      ['new', 'Начален екран: избор на правила (без/с минуси) и „на устройството / по мрежа“.'],
      ['new', 'При влизане в игра по мрежа с различни правила/тип — предупреждение (но не блокира).'],
      ['rem', 'Отделният бутон „Игра по интернет“ — вече е през избора „по мрежа“.'] ] },
    { v: '1.19.x', items: [
      ['new', '„Нови зарове“ (подреди/раздели) — в настройките, при стопанина и на бутона „?“.'],
      ['chg', '„КАЗАРМА“ се преименува на „Сол и хранилки“.'],
      ['fix', 'Съветите „с минуси“ вече следват настройката (не са включени по подразбиране).'],
      ['fix', 'Менютата „с минуси“ вече не махат „два чифта“ от дъската.'],
      ['new', 'Личният рекорд показва и най-нисък резултат, не само най-висок.'] ] },
    { v: '1.18.x', items: [
      ['new', '„Нови зарове“: новохвърлените зарове се групират отделно (и в обобщението).'],
      ['fix', '„С минуси“: −50 се добавя ВЪРХУ минуса в числовата част (а не вместо него).'] ] },
    { v: '1.17.x', items: [
      ['chg', 'Режимът на играта (зарове/отчет) е избор на старшината; гостите го наследяват.'],
      ['new', 'Играта по интернет е официална функция (вече не е скрита).'] ] },
    { v: '1.15–1.16', items: [
      ['new', 'QR код за играта: хостът го показва, гостът го сканира.'],
      ['new', 'Поставяне на кода от клипборда + живо показване на избора на зарове.'] ] },
  ];
  function renderChangelog() {
    var h = '<div class="clog-hd">Какво ново</div>';
    CHANGELOG.forEach(function (rel) {
      h += '<div class="clog-v">v' + rel.v + '</div>';
      rel.items.forEach(function (it) { h += '<div class="clog-i"><span class="clog-tag ' + it[0] + '">' + it[0] + '</span><span>' + it[1] + '</span></div>'; });
    });
    return h;
  }
  function toggleChangelog(anchor) {
    var b = $('changelogPop');
    if (!b.classList.contains('hidden')) { b.classList.add('hidden'); return; }
    b.innerHTML = renderChangelog(); b.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    b.style.left = Math.min(Math.max(8, r.right - b.offsetWidth), window.innerWidth - b.offsetWidth - 8) + 'px';
    var below = r.bottom + 8;
    b.style.top = (below + b.offsetHeight < window.innerHeight - 8 ? below : Math.max(8, r.top - b.offsetHeight - 8)) + 'px';
  }
  (function () {
    var av = $('appVer');
    if (av) {
      av.textContent = 'v' + APP_VERSION;
      av.title = 'Какво ново';
      av.onclick = function (e) { e.stopPropagation(); toggleChangelog(av); };
    }
    // tap anywhere else closes the changelog popover
    document.addEventListener('click', function (e) {
      var b = $('changelogPop');
      if (b && !b.classList.contains('hidden') && e.target !== av && !b.contains(e.target)) b.classList.add('hidden');
    });
  })();
  // positive toggles. Титли (rare-name notifications) is its own switch, independent
  // of КАЗАРМА; titlePoints (extra points from rare names) is its hidden sub-toggle.
  // глупости (profanity) ON by default = NSFW words allowed; OFF = censored to the SFW set
  // selectKeep: which dice you tap each throw — false = tap the ones to RE-THROW (ОГИН!),
  // true = tap the ones to KEEP (ДРЪЖ!). Default „keep". This is the owner's/default
  // preference (set in owner customisation); each HUMAN player carries their own copy
  // (p.selectKeep) so several humans in one game can play in different flavours.
  var settings = { titles: false, titlePoints: false, advice: false, glupost: true, barracks: false, bets: false, acoustic: false, acousticDebug: false, webrtc: true, webrtcDebug: false, opticalHandshake: false, newDiceBatch: false, iceServers: '', selectKeep: true, ruleset: 'experimental', ownerName: '', useOwnerName: false, ownerGender: 'm', ownerColor: '#d4a02e' };
  function fun() { return !!settings.barracks; } // is the goofy layer enabled?
  function namePointsOn() { return !!(settings.titles && settings.titlePoints); } // rare-name bonus points enabled
  function total(p) { return (game && game.ruleset === 'experimental') ? X.total(p) : G.playerTotal(p) + (p.bonus || 0); } // includes name bonus
  // dice-roll footer + fire bar vs the manual-entry footer
  function setDockUI(manual) { if (manual) $('bottombar').classList.remove('preroll'); $('firebar').classList.toggle('hidden', manual); $('diceFooter').classList.toggle('hidden', manual); $('manualDock').classList.toggle('hidden', !manual); }
  // reserve scroll space under the fixed overlay bar so nothing stays hidden behind it
  var barFullH = 0;   // remembered full (dice + button) bar height so the pre-throw state keeps the same size
  // measure the bar at its full rolling-state height without flashing — done in a single
  // synchronous layout pass (offsetHeight forces layout, not paint), so no flicker
  function measureBarFull(bb) {
    var pre = bb.classList.contains('preroll'), mh = bb.style.minHeight;
    if (pre) bb.classList.remove('preroll');
    bb.style.minHeight = '';
    var h = bb.offsetHeight;
    bb.style.minHeight = mh;
    if (pre) bb.classList.add('preroll');
    return h;
  }
  function syncBottomPad() {
    var bb = $('bottombar'), gb = $('gamebody'); if (!bb || !gb) return;
    if (bb.classList.contains('preroll')) { barFullH = measureBarFull(bb); bb.style.minHeight = barFullH + 'px'; }
    else { bb.style.minHeight = ''; barFullH = bb.offsetHeight; }
    gb.style.paddingBottom = (bb.offsetHeight + 8) + 'px';
  }
  window.addEventListener('resize', syncBottomPad);

  // ---------- persistent settings + game archive (localStorage) ----------
  var SETTINGS_KEY = 'general:settings:v1', HISTORY_KEY = 'general:history:v1', RESUME_KEY = 'general:resume:v1';
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

  function saveSettings() {
    var s = { titles: settings.titles, titlePoints: settings.titlePoints, advice: settings.advice, glupost: settings.glupost,
              barracks: settings.barracks, bets: settings.bets, acoustic: settings.acoustic, acousticDebug: settings.acousticDebug, webrtc: settings.webrtc, webrtcDebug: settings.webrtcDebug, opticalHandshake: settings.opticalHandshake, newDiceBatch: settings.newDiceBatch, iceServers: settings.iceServers, selectKeep: settings.selectKeep, ruleset: settings.ruleset, ownerName: settings.ownerName, useOwnerName: settings.useOwnerName, ownerGender: settings.ownerGender, ownerColor: settings.ownerColor };
    lsSet(SETTINGS_KEY, JSON.stringify(s));
  }
  function loadSettings() {
    var raw = lsGet(SETTINGS_KEY); if (!raw) return;
    try {
      var s = JSON.parse(raw);
      ['titles', 'titlePoints', 'advice', 'glupost', 'barracks', 'bets', 'acoustic', 'acousticDebug', 'webrtc', 'webrtcDebug', 'opticalHandshake', 'newDiceBatch', 'iceServers', 'selectKeep', 'ruleset', 'ownerName', 'useOwnerName', 'ownerGender', 'ownerColor'].forEach(function (k) { if (s[k] != null) settings[k] = s[k]; });
      if (s.glupost == null && s.censor != null) settings.glupost = !s.censor;   // migrate the old (inverted) Цензура toggle
      // advice intentionally NOT migrated — it must default OFF (legacy `bonus` is dropped)
      settings.webrtc = true;   // internet play is now a release feature — always on, even for older saves
    } catch (e) {}
    G.setCensor(!settings.glupost);   // глупости on ⇒ don't censor
  }

  function loadHistory() { var raw = lsGet(HISTORY_KEY); if (!raw) return []; try { var a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  // save as many games as storage allows: on a quota error, drop the oldest and retry
  function persistHistory(arr) {
    while (arr.length) { if (lsSet(HISTORY_KEY, JSON.stringify(arr))) return true; arr.shift(); }
    lsDel(HISTORY_KEY); return false;
  }
  var lastGameRec = null;   // the most recently archived record (so a live summary can annotate it)
  function archiveGame(rec) { var arr = loadHistory(); arr.push(rec); persistHistory(arr); lastGameRec = rec; return rec; }

  // serialise the live players (shared by the archive and the resume snapshot)
  function serializePlayers() {
    return game.players.map(function (p) {
      return { name: p.name, color: p.color, isAI: !!p.isAI, owner: !!p.owner, personaId: p.persona ? p.persona.id : null,
               gender: p.gender, bet: p.bet, scores: p.scores, bonus: p.bonus || 0, ribbons: p.ribbons || [],
               selectKeep: p.selectKeep, diceBatch: p.diceBatch };
    });
  }
  // ---- resume: snapshot the game at each turn boundary so a reload can continue ----
  function saveResume() {
    if (!game || !game.players || !game.players.length || viewingHistory || tut) return;   // tutorial games aren't resumable
    var over = expMode ? X.isGameOver(game) : G.isGameOver(game);
    if (over) { clearResume(); return; }
    lsSet(RESUME_KEY, JSON.stringify({
      v: 1, ts: Date.now(), ruleset: expMode ? 'experimental' : 'standard', manualMode: manualMode,
      current: game.current, round: game.round, ownerSkipped: !!game.ownerSkipped, players: serializePlayers(), moveLog: moveLog,
    }));
  }
  function loadResume() {
    var raw = lsGet(RESUME_KEY); if (!raw) return null;
    try { var s = JSON.parse(raw); return (s && Array.isArray(s.players) && s.players.length) ? s : null; } catch (e) { return null; }
  }
  function clearResume() { lsDel(RESUME_KEY); }

  // The device owner is a FLAGGED player (p.owner) — the token follows them when
  // the seats are reordered. Initialised on the first player.
  function isOwnerP(p) { return !!(p && p.owner); }
  function ownerTokenHTML(small) { return '<span class="ownertok' + (small ? ' sm' : '') + '" title="Стопанин на устройството"><i>★</i></span>'; }
  function ownerOf(players) { for (var i = 0; i < players.length; i++) if (players[i].owner) return players[i]; return players[0]; }
  function ensureOwner() { if (ownerDetached) return; if (setupPlayers.length && !setupPlayers.some(isOwnerP)) setupPlayers[0].owner = true; }
  // force the owner's name to the configured owner name when the toggle is on
  function applyOwnerName() {
    ensureOwner();
    if (!setupPlayers.length || ownerDetached) return;   // detached: seat #1 keeps its own name, no owner defaults
    if (settings.useOwnerName && settings.ownerName.trim()) {
      var p = ownerOf(setupPlayers);
      p.name = settings.ownerName.trim(); p.gender = settings.ownerGender || p.gender;   // custom name carries the chosen gender
      p.pct = null; p.tier = 0; p.bonus = 0; p.parts = null; p.typed = true; p.bubbleDismissed = true;
    }
  }

  var PIPS = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] };
  // a blocky "?" drawn from square pip-coloured blocks (6 cols x 6 rows)
  var QMARK = [
    0,1,1,1,1,0,
    0,0,0,0,1,0,
    0,0,1,1,1,0,
    0,0,1,0,0,0,
    0,0,0,0,0,0,
    0,0,1,0,0,0,
  ];
  function qmarkHTML() {
    var s = '';
    for (var i = 0; i < QMARK.length; i++) s += '<span class="' + (QMARK[i] ? 'on' : '') + '"></span>';
    return '<span class="ghostq">' + s + '</span>';
  }
  // 14 distinct, well-spaced colours (custom picker — no system colour dialog)
  var PRESET_COLORS = ['#d4a02e', '#e07a2e', '#cf4f2e', '#c0392b', '#c2407a', '#9b3fb0', '#6a52c0',
                       '#3f5fc0', '#2f86c8', '#2aa0a0', '#2e9e5b', '#6aa83a', '#a39a2e', '#9a6b3a'];
  // pick a preset colour not used by anyone (except `except`); fall back to prefer/first
  function pickFreeColor(except, prefer) {
    var used = setupPlayers.filter(function (p) { return p !== except; }).map(function (p) { return (p.color || '').toLowerCase(); });
    if (prefer && used.indexOf(prefer.toLowerCase()) < 0) return prefer;
    for (var i = 0; i < PRESET_COLORS.length; i++) if (used.indexOf(PRESET_COLORS[i].toLowerCase()) < 0) return PRESET_COLORS[i];
    return prefer || PRESET_COLORS[0];
  }
  // no two seats share a colour; the owner's colour is protected (others bump)
  function dedupeColors() {
    var owner = setupPlayers.filter(isOwnerP)[0] || null, used = {};   // protect only a REAL owner's colour (none while detached)
    if (owner) used[(owner.color || '').toLowerCase()] = 1;
    setupPlayers.forEach(function (p) {
      if (p === owner) return;
      var c = (p.color || '').toLowerCase();
      if (used[c]) { p.color = pickFreeColor(p); c = p.color.toLowerCase(); }
      used[c] = 1;
    });
  }
  // no two seats share a name; regenerate generated dupes, suffix typed ones
  function dedupeNames() {
    var seen = {};
    setupPlayers.forEach(function (p) {
      if (seen[(p.name || '').toLowerCase()]) {
        if (!p.typed) for (var g = 0; g < 25 && seen[(p.name || '').toLowerCase()]; g++) regenName(p);
        if (seen[(p.name || '').toLowerCase()]) { var base = p.name, i = 2; while (seen[(base + ' ' + i).toLowerCase()]) i++; p.name = base + ' ' + i; }
      }
      seen[(p.name || '').toLowerCase()] = 1;
    });
  }
  var RIBBON_COLORS = ['#b23a2e', '#2f4a6b', '#c8a64b', '#3f6b3a', '#7a4632', '#c8a64b'];
  var AI_DELAY = 680, END_DELAY = 620, AI_VIEW_DELAY = 1500, ROLLS = G.MAX_ROLLS; // 1 auto roll + (ROLLS-1) rerolls
  var NET_HANDOVER_DELAY = 2800;   // net: hold the committed board longer so the chosen category is clearly seen before the turn passes

  function initials(name) {
    var p = name.trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p[p.length - 1] || '')[0] || '?').toUpperCase();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function pipFace(v) {
    var s = '';
    for (var c = 0; c < 9; c++) s += '<span class="pip' + (PIPS[v].indexOf(c) > -1 ? ' on' : '') + '"></span>';
    return '<span class="face">' + s + '</span>';
  }

  // camouflage + scrim, injected into a board element
  function paintCamo(el) {
    if (el.querySelector('.camo')) return;
    var svg = '<svg class="camo" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">'
      + '<defs>'
      + '<filter id="cam1"><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="11" result="n"/>'
      + '<feComponentTransfer in="n" result="m"><feFuncA type="discrete" tableValues="0 0 0 1 1"/></feComponentTransfer>'
      + '<feFlood flood-color="#39401a" result="f"/><feComposite in="f" in2="m" operator="in"/></filter>'
      + '<filter id="cam2"><feTurbulence type="fractalNoise" baseFrequency="0.026" numOctaves="3" seed="29" result="n"/>'
      + '<feComponentTransfer in="n" result="m"><feFuncA type="discrete" tableValues="0 0 1 1"/></feComponentTransfer>'
      + '<feFlood flood-color="#717449" result="f"/><feComposite in="f" in2="m" operator="in"/></filter>'
      + '<filter id="cam3"><feTurbulence type="fractalNoise" baseFrequency="0.034" numOctaves="2" seed="47" result="n"/>'
      + '<feComponentTransfer in="n" result="m"><feFuncA type="discrete" tableValues="0 0 0 0 1"/></feComponentTransfer>'
      + '<feFlood flood-color="#26261a" result="f"/><feComposite in="f" in2="m" operator="in"/></filter>'
      + '</defs>'
      + '<rect width="100%" height="100%" fill="#4a5223"/>'
      + '<rect width="100%" height="100%" filter="url(#cam1)"/>'
      + '<rect width="100%" height="100%" filter="url(#cam2)"/>'
      + '<rect width="100%" height="100%" filter="url(#cam3)"/></svg>'
      + '<div class="scrim"></div>';
    el.insertAdjacentHTML('afterbegin', svg);
  }

  function medalSVG(type) {
    var stripes = { star:['#b23a2e','#d7cdab','#b23a2e'], disc:['#2f4a6b','#c8a64b','#2f4a6b'], cross:['#3f4a1f','#c8a64b','#3f4a1f'] }[type];
    var bars = stripes.map(function (c, i) { return '<rect x="' + (12 + i * 5.33) + '" y="0" width="5.34" height="17" fill="' + c + '"/>'; }).join('');
    var emblem = type === 'star'
      ? '<path d="M20,21 L22.7,28.3 L30.5,28.6 L24.4,33.4 L26.5,40.9 L20,36.6 L13.5,40.9 L15.6,33.4 L9.5,28.6 L17.3,28.3 Z" fill="#e8c356" stroke="#6e5418" stroke-width="1"/>'
      : type === 'disc'
      ? '<g><circle cx="20" cy="32" r="11" fill="#e8c356" stroke="#6e5418" stroke-width="1.4"/><circle cx="20" cy="32" r="7" fill="none" stroke="#6e5418" stroke-width="0.8"/><text x="20" y="36" text-anchor="middle" font-size="11" fill="#6e5418">★</text></g>'
      : '<g fill="#e8c356" stroke="#6e5418" stroke-width="1"><rect x="17.5" y="21.5" width="5" height="21" rx="1"/><rect x="9.5" y="29.5" width="21" height="5" rx="1"/></g>';
    return '<svg viewBox="0 0 40 50" width="36" height="46" aria-hidden="true"><rect x="12" y="0" width="16" height="17" fill="#1c1d12"/>'
      + bars + '<polygon points="12,17 28,17 24,21 16,21" fill="#000" opacity="0.3"/>' + emblem + '</svg>';
  }

