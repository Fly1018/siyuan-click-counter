/**
 * siyuan-click-counter —— 双击块里的数字就 +1
 *
 * 用途：日记/清单里「喝水：1次」这种小计数块，双击一次就把数字累加，不用手动改。
 *
 * 触发方式：**双击**该块（第二次按下时触发，并顺带抑制"双击选中单词"）。
 *   单击 = 正常编辑/放光标，完全不受影响；想选中单词用 Alt + 双击。
 *
 * 生效条件（满足其一即可）：
 *   1) 块首行能被「匹配规则」里的某条正则命中，默认规则覆盖：
 *      · 「喝水：1次」「喝咖啡：2杯」「俯卧撑：30个」这类"名称：数字[单位]"；
 *      · 「喝水 ×3」这类"名称 ×数字"；
 *      · 「1/7」「喝水：1/7」「学习 3/10」这类"当前/目标"：只累加斜杠前的数字，分母不动，
 *        且**到分母就封顶**（7/7 之后双击不再增长，只提示"已达目标"）；
 *   2) 块上带 custom-click-counter 属性：值写 off 表示关闭，写 +2 / -1 单独指定步长，
 *      其他值表示强制启用（规则没命中时，退回改「行尾最后一个数字」）。
 *
 * 只改数据，不伪造 DOM：先 SQL 确认块在内核里存在，再用 /api/block/getBlockKramdown 取内容、
 * /api/block/updateBlock 回写，inline 格式与自定义属性都保留。
 *
 * 不参与计数的情形（避免误动作）：
 *   · 代码块 / 公式块 / HTML 块 / 图片 / 引用 / 属性视图 / 块标菜单等区域；
 *   · 只读预览、对话框里的静态渲染；
 *   · 界面上存在但内核里没有的「前端临时块」（例如智能体对话框的消息气泡与输入框）——
 *     计数前会先查库，缺失就静默跳过，不发出任何会失败的请求。
 *
 * 其他入口：
 *   块图标菜单      → 「计数 +1 / -1」（单击块标即可，与双击互不影响）
 *   命令面板        → 打开设置 / 光标所在块 +1 / -1 / 诊断 / 检查界面残留块
 */

const siyuan = require("siyuan");
const { Plugin, Setting, Dialog, showMessage } = siyuan;

/* ---------- 常量 ---------- */

// 块属性名：写在块上表示强制启用；off 关闭；+2 / -1 单独指定步长
const ATTR = "custom-click-counter";
const CFG_FILE = "settings.json";
const STYLE_ID = "siyuan-click-counter-style";

// 块 ID 形态：14 位时间戳 + 7 位随机串
const ID_RE = /^\d{14}-[0-9a-z]{7}$/;

// 存在性缓存上限
const EXISTS_CACHE_MAX = 600;

// 默认匹配规则（一行一条正则；需含 3 个捕获组：名称 / 数字 / 单位，单位可空）
const DEFAULT_PATTERNS = [
    // 名称：数字[单位]
    "^(\\S.{0,38}?)\\s*[:：]\\s*(\\d+)\\s*(次|杯|个|遍|组|下|页|口|瓶|颗|片|场|分钟|小时|公里|km)?$",
    // 名称 ×数字
    "^(.{1,40}?)\\s*[×✕]\\s*(\\d+)\\s*$",
    // 当前/目标：1/7、喝水：1/7、学习 3/10（只动斜杠前的数字，到分母封顶）
    "^(?:(\\S.{0,38}?)\\s*[:：]?\\s*|[ \\t]*)(\\d{1,3})(\\s*[\\/／]\\s*\\d+.*)$",
];

// v1.0.x ~ v1.1.0 的默认规则：老配置若没改过规则，平滑升级到新默认
const LEGACY_PATTERNS = [
    "^(\\S.{0,38}?)\\s*[:：]\\s*(\\d+)\\s*(次|杯|个|遍|组|下|页|口|瓶|颗|片|场|分钟|小时|公里|km)?$\n" +
    "^(.{1,40}?)\\s*[×✕]\\s*(\\d+)\\s*$",
];

// 带属性但没命中规则时，退回「改行尾最后一个数字」
const LOOSE_RE = /^(.*?)(\d+)([^\d]*)$/;

// 从「单位」里认分母，例如 "/7""/ 7 次" → 7；没有斜杠就是 0（不封顶）
const CAP_RE = /[\/／]\s*(\d+)/;

// 首行里可以剥掉、计数后原样放回的前缀：标题号、列表符号、任务框
const HEAD_RE = /^([ \t]*)((?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)?)/;

// 只有这些块参与计数（容器块交给它们内部的段落）
const ALLOW_TYPES = ["NodeParagraph", "NodeHeading", "NodeBlockquote", "NodeTableCell"];

// 这些区域里的点击不计数
const SKIP_SELECTOR = "a, .protyle-action, .protyle-icons, .protyle-attr, .protyle-gutters, " +
    ".protyle-toolbar, .b3-menu, .b3-dialog, [data-type='block-ref'], [data-type='img'], " +
    "[data-type='html-block'], [data-type='av'], [data-type='NodeCodeBlock'], [data-type='NodeMathBlock']";

const DEFAULT_CFG = {
    enabled: true,
    step: 1,
    patterns: DEFAULT_PATTERNS.join("\n"),
    flash: true,
    notify: true,
    debug: false,
};

const CSS = [
    ".cc-flash-up{animation:cc-flash-up .5s ease-out}",
    ".cc-flash-down{animation:cc-flash-down .5s ease-out}",
    "@keyframes cc-flash-up{from{background-color:rgba(63,148,255,.28)}to{background-color:transparent}}",
    "@keyframes cc-flash-down{from{background-color:rgba(255,122,122,.28)}to{background-color:transparent}}",
].join("\n");

/* ---------- 工具 ---------- */

function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

async function api(url, data) {
    const direct = siyuan.fetchSyncPost;
    if (typeof direct === "function") {
        const res = await direct(url, data || {});
        if (!res) {
            throw new Error("无响应");
        }
        if (res.code !== 0) {
            throw new Error(res.msg || ("code " + res.code));
        }
        return res.data;
    }
    const res = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(data || {}),
    });
    const json = await res.json();
    if (json.code !== 0) {
        throw new Error(json.msg || ("code " + json.code));
    }
    return json.data;
}

// 一行一条规则：支持 /正则/标志 写法，也支持裸正则
function compilePattern(text) {
    const line = String(text || "").trim();
    if (!line || line.charAt(0) === "#") {
        return null;
    }
    try {
        const m = /^\/(.+)\/([a-z]*)$/i.exec(line);
        if (m) {
            return new RegExp(m[1], m[2].replace(/[gy]/g, ""));
        }
        return new RegExp(line, "i");
    } catch (e) {
        return null;
    }
}

// 把 "{: id="x" custom-a="b"}" 拆成 token 数组；不是属性行则返回 null
function tokenizeIal(line) {
    const m = /^\s*\{:\s*(.*?)\s*\}\s*$/.exec(line || "");
    if (!m) {
        return null;
    }
    const tokens = m[1].match(/[A-Za-z0-9_-]+=(?:"[^"]*"|'[^']*'|\S+)/g);
    return tokens || [];
}

/* ---------- 插件 ---------- */

class ClickCounter extends Plugin {

    async onload() {
        this.cfg = Object.assign({}, DEFAULT_CFG);
        this.busy = new Set();
        this.queue = new Map();
        this.existsCache = new Map();
        this.hinted = new Set();
        this.patternCache = {source: null, list: []};
        this.lastApi = "";
        this.onMouseDown = this.handleMouseDown.bind(this);
        this.onBlockIcon = this.handleBlockIcon.bind(this);

        await this.loadCfg();
        this.injectStyle();

        document.addEventListener("mousedown", this.onMouseDown, true);
        try {
            this.eventBus.on("click-blockicon", this.onBlockIcon);
        } catch (e) {
            console.warn("[siyuan-click-counter] 注册块图标菜单失败", e);
        }

        this.addSetting();
        this.addCommand({langKey: "openSetting", hotkey: "", callback: () => this.openSetting()});
        this.addCommand({langKey: "countCursor", hotkey: "", callback: () => this.countAtCursor(1)});
        this.addCommand({langKey: "uncountCursor", hotkey: "", callback: () => this.countAtCursor(-1)});
        this.addCommand({langKey: "diagnose", hotkey: "", callback: () => this.diagnose()});
        this.addCommand({langKey: "scanPhantom", hotkey: "", callback: () => this.scanPhantom()});

        console.log("[siyuan-click-counter] onload，双击计数已就绪");
    }

    onunload() {
        document.removeEventListener("mousedown", this.onMouseDown, true);
        try {
            this.eventBus.off("click-blockicon", this.onBlockIcon);
        } catch (e) {
            // 忽略
        }
        const style = document.getElementById(STYLE_ID);
        if (style) {
            style.remove();
        }
        console.log("[siyuan-click-counter] onunload");
    }

    /* ---------- 配置 ---------- */

    async loadCfg() {
        try {
            const saved = await this.loadData(CFG_FILE);
            if (saved && typeof saved === "object") {
                this.cfg = Object.assign({}, DEFAULT_CFG, saved);
            }
        } catch (e) {
            console.warn("[siyuan-click-counter] 读取配置失败", e);
        }
        // 规则为空、或还是老版本的默认规则 → 用当前默认（老配置平滑升级）
        const cur = typeof this.cfg.patterns === "string" ? this.cfg.patterns.trim() : "";
        if (!cur || LEGACY_PATTERNS.indexOf(cur) > -1) {
            this.cfg.patterns = DEFAULT_PATTERNS.join("\n");
        }
        this.cfg.step = this.normStep(this.cfg.step);
    }

    async saveCfg() {
        try {
            await this.saveData(CFG_FILE, this.cfg);
        } catch (e) {
            console.warn("[siyuan-click-counter] 保存配置失败", e);
        }
    }

    normStep(value) {
        const n = parseFloat(value);
        if (!Number.isFinite(n) || n === 0) {
            return 1;
        }
        return n;
    }

    t(key) {
        if (this.i18n && typeof this.i18n[key] === "string") {
            return this.i18n[key];
        }
        return key;
    }

    log() {
        if (!this.cfg || !this.cfg.debug) {
            return;
        }
        const args = Array.prototype.slice.call(arguments);
        args.unshift("[siyuan-click-counter]");
        console.log.apply(console, args);
    }

    getPatterns() {
        const src = String(this.cfg.patterns || "");
        if (this.patternCache.source !== src) {
            const list = [];
            src.split("\n").forEach(function (raw) {
                const re = compilePattern(raw);
                if (re) {
                    list.push(re);
                }
            });
            this.patternCache = {source: src, list: list};
        }
        return this.patternCache.list;
    }

    /* ---------- 双击入口 ---------- */

    handleMouseDown(event) {
        const target = event.target;
        if (!this.cfg.enabled) {
            return;
        }
        // 只认双击的第二次按下（detail=2）：双击计数，单击保持正常编辑
        if (event.button !== 0 || event.detail !== 2) {
            return;
        }
        // 按修饰键 = 不计数（想双击选中单词时按住 Alt）
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }
        if (!target || target.nodeType !== 1 || !target.closest) {
            return;
        }
        if (target.closest(SKIP_SELECTOR)) {
            return;
        }
        const wysiwyg = target.closest(".protyle-wysiwyg");
        if (!wysiwyg) {
            return;
        }
        // 只认 .protyle 里的块
        if (!wysiwyg.closest(".protyle")) {
            return;
        }
        // 只读区域（静态预览）不碰
        if (wysiwyg.closest(".b3-dialog, .protyle-preview") || wysiwyg.closest('[contenteditable="false"]')) {
            return;
        }
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && String(selection).trim()) {
            return;
        }
        const blockEl = target.closest("[data-node-id][data-type]");
        if (!blockEl || blockEl === wysiwyg) {
            return;
        }
        const id = blockEl.dataset ? String(blockEl.dataset.nodeId || "") : "";
        if (!ID_RE.test(id)) {
            return;
        }
        if (blockEl.classList.contains("protyle-wysiwyg--select")) {
            return;
        }
        if (ALLOW_TYPES.indexOf(blockEl.getAttribute("data-type") || "") < 0) {
            return;
        }
        const attr = String(blockEl.getAttribute(ATTR) || "").trim();
        if (this.isAttrOff(attr)) {
            return;
        }
        // 抑制「双击选中单词」，避免计数时闪一下选区
        event.preventDefault();
        this.countIfReal(blockEl, this.deltaFromAttr(attr, this.cfg.step), attr).catch(function () {
        });
    }

    handleBlockIcon(event) {
        if (!this.cfg.enabled) {
            return;
        }
        const detail = event && event.detail;
        if (!detail || !detail.menu || typeof detail.menu.addItem !== "function") {
            return;
        }
        const els = [];
        const list = detail.blockElements || (detail.blockElement ? [detail.blockElement] : []);
        for (let i = 0; i < list.length; i++) {
            const el = list[i];
            if (el && el.dataset && el.dataset.nodeId) {
                els.push(el);
            }
        }
        if (!els.length) {
            return;
        }
        detail.menu.addItem({
            icon: "iconAdd",
            label: this.t("menuAdd"),
            click: () => this.countList(els, 1),
        });
        detail.menu.addItem({
            icon: "iconRemove",
            label: this.t("menuMinus"),
            click: () => this.countList(els, -1),
        });
    }

    countList(els, dir) {
        const sign = dir < 0 ? -1 : 1;
        els.forEach((el) => {
            const attr = String(el.getAttribute(ATTR) || "").trim();
            if (this.isAttrOff(attr)) {
                return;
            }
            this.countIfReal(el, sign * Math.abs(this.deltaFromAttr(attr, this.cfg.step)), attr).catch(function () {
            });
        });
    }

    countAtCursor(dir) {
        const el = this.blockAtCursor();
        if (!el) {
            showMessage(this.t("noBlock"), 3000, "info");
            return;
        }
        const attr = String(el.getAttribute(ATTR) || "").trim();
        if (this.isAttrOff(attr)) {
            showMessage(this.t("attrOff"), 3000, "info");
            return;
        }
        const sign = dir < 0 ? -1 : 1;
        this.countIfReal(el, sign * Math.abs(this.deltaFromAttr(attr, this.cfg.step)), attr).catch(function () {
        });
    }

    blockAtCursor() {
        const selection = window.getSelection();
        let node = selection && selection.anchorNode ? selection.anchorNode : null;
        if (node && node.nodeType === 3) {
            node = node.parentElement;
        }
        if (!node || !node.closest) {
            return null;
        }
        const el = node.closest("[data-node-id][data-type]");
        if (!el || !el.closest(".protyle-wysiwyg")) {
            return null;
        }
        return el;
    }

    /* ---------- 计数 ---------- */

    isAttrOff(value) {
        const s = String(value || "").trim().toLowerCase();
        return s === "off" || s === "no" || s === "false" || s === "0";
    }

    deltaFromAttr(attr, baseStep) {
        const v = String(attr || "").trim();
        const m = /^[+-]?\d+$/.exec(v);
        if (m) {
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n !== 0) {
                return n;
            }
        }
        return this.normStep(baseStep);
    }

    // 块是否真的在内核里（前端临时块返回 false，且这个查询不会报错）
    async blockExists(id) {
        const hit = this.existsCache.get(id);
        if (hit !== undefined) {
            return hit;
        }
        const data = await api("/api/query/sql", {stmt: "SELECT id FROM blocks WHERE id = '" + id + "' LIMIT 1"});
        const ok = Array.isArray(data) && data.length > 0;
        if (this.existsCache.size > EXISTS_CACHE_MAX) {
            const keys = Array.from(this.existsCache.keys());
            for (let i = 0; i < 200 && i < keys.length; i++) {
                this.existsCache.delete(keys[i]);
            }
        }
        this.existsCache.set(id, ok);
        return ok;
    }

    // 计数前先校验存在性：库里没有的直接跳过，避免发出会失败的请求
    async countIfReal(blockEl, delta, attr) {
        const id = blockEl && blockEl.dataset ? String(blockEl.dataset.nodeId || "") : "";
        if (!id || !delta) {
            return;
        }
        let exists = true;
        try {
            exists = await this.blockExists(id);
        } catch (e) {
            exists = true;
        }
        if (!exists) {
            this.log("跳过前端临时块", id);
            // 只在"有标题的真文档"里提示一次；面板/聊天输入框保持安静
            if (this.docTitleOf(blockEl) && !this.hinted.has(id)) {
                this.hinted.add(id);
                showMessage(this.t("phantomMsg"), 6000, "info");
            }
            return;
        }
        await this.count(blockEl, delta, attr);
    }

    // 同一个块上的连点排队累加，不会因为请求未回而吞掉点击
    async count(blockEl, delta, attr) {
        const id = blockEl && blockEl.dataset ? String(blockEl.dataset.nodeId || "") : "";
        if (!id || !delta) {
            return;
        }
        if (this.busy.has(id)) {
            this.queue.set(id, (this.queue.get(id) || 0) + delta);
            return;
        }
        this.busy.add(id);
        let step = delta;
        try {
            // 双击的第一次点击已把光标放进该块，稍等让可能的编辑事务落库，避免回写覆盖
            await sleep(100);
            while (true) {
                let ok = false;
                try {
                    ok = await this.applyOnce(id, blockEl, step, attr);
                } catch (e) {
                    this.reportFail(id, blockEl, e);
                }
                if (!ok) {
                    this.queue.delete(id);
                    break;
                }
                const queued = this.queue.get(id);
                if (!queued) {
                    break;
                }
                this.queue.delete(id);
                step = queued;
            }
        } finally {
            this.busy.delete(id);
        }
    }

    // 兜底：块不存在（界面残留）→ 静默记日志；其余 → 报错
    reportFail(id, blockEl, e) {
        const msg = e && e.message ? e.message : String(e);
        if (/not found/i.test(msg)) {
            this.existsCache.set(id, false);
            this.log("块已不在内核中", id);
            if (this.docTitleOf(blockEl) && !this.hinted.has(id)) {
                this.hinted.add(id);
                showMessage(this.t("phantomMsg"), 6000, "info");
            }
            return;
        }
        console.warn("[siyuan-click-counter] 计数失败", e);
        showMessage(this.t("failed") + "[" + this.lastApi + " " + id + "]：" + msg, 6000, "error");
    }

    docTitleOf(el) {
        try {
            const protyle = el && el.closest ? el.closest(".protyle") : null;
            if (!protyle) {
                return "";
            }
            const title = protyle.querySelector(".protyle-title__input");
            return title ? String(title.textContent || "").trim() : "";
        } catch (e) {
            return "";
        }
    }

    // 这块渲染在哪儿：编辑器（哪个文档）/ 对话框 / 其它面板
    contextOf(el) {
        try {
            const protyle = el && el.closest ? el.closest(".protyle") : null;
            if (protyle) {
                const inDialog = protyle.closest(".b3-dialog");
                const title = this.docTitleOf(el) || "（未命名文档）";
                return (inDialog ? "对话框编辑器：" : "编辑器：") + title;
            }
            const dialog = el.closest(".b3-dialog");
            if (dialog) {
                const header = dialog.querySelector(".b3-dialog__header, .b3-dialog__title");
                const text = header ? String(header.textContent || "").trim().slice(0, 20) : "";
                return "对话框：" + (text || "（无标题）");
            }
            const parts = [];
            let node = el.parentElement;
            while (node && node !== document.body && parts.length < 4) {
                const cls = String(node.className || "").split(" ").filter(function (c) {
                    return c && c.indexOf("fn__") !== 0 && c.indexOf("b3-") !== 0;
                })[0] || "";
                parts.unshift(node.tagName.toLowerCase() + (cls ? "." + cls : ""));
                node = node.parentElement;
            }
            return "其它：" + (parts.join(" > ") || "未知容器");
        } catch (e) {
            return "未知容器";
        }
    }

    async applyOnce(id, blockEl, delta, attr) {
        this.lastApi = "getBlockKramdown";
        const kramdown = await this.getKramdown(id);
        if (!kramdown) {
            return false;
        }
        const lines = kramdown.split("\n");
        // 多行块（含子块）不处理，避免回写时丢内容
        if (lines.length > 2) {
            this.log("多行块，跳过", id);
            return false;
        }
        let ial = "";
        if (lines.length === 2) {
            const tokens = tokenizeIal(lines[1]);
            if (!tokens) {
                this.log("第二行不是属性行，跳过", id);
                return false;
            }
            // id / updated 由内核维护，回写时丢掉，其余自定义属性原样带上
            const kept = tokens.filter(function (tok) {
                return !/^(id|updated)=/.test(tok);
            });
            ial = kept.length ? "{: " + kept.join(" ") + " }" : "";
        }

        const parsed = this.parseLine(lines[0], attr);
        if (!parsed) {
            this.log("未命中匹配规则", lines[0]);
            return false;
        }
        // 「当前/目标」这种带分母的，到分母就封顶
        const raw = parsed.num + delta;
        let value = Math.max(0, raw);
        if (parsed.cap > 0) {
            value = Math.min(parsed.cap, value);
        }
        if (value === parsed.num) {
            if (this.cfg.notify) {
                const suffix = parsed.cap > 0 && raw > parsed.cap ? this.t("capMax") : this.t("capMin");
                showMessage(this.plain(parsed.name) + parsed.sep + value + parsed.unit + suffix, 2000, "info");
            }
            this.log("已达边界，未改动", id);
            return false;
        }
        const nextLine = lines[0].slice(0, parsed.start) + String(value) + lines[0].slice(parsed.start + parsed.len);
        if (nextLine === lines[0]) {
            return false;
        }

        if (this.cfg.flash && blockEl && blockEl.isConnected) {
            this.flash(blockEl, delta >= 0);
        }
        this.lastApi = "updateBlock";
        await api("/api/block/updateBlock", {
            id: id,
            dataType: "markdown",
            data: ial ? nextLine + "\n" + ial : nextLine,
        });
        if (this.cfg.notify) {
            showMessage(this.plain(parsed.name) + parsed.sep + value + parsed.unit, 2000, "info");
        }
        this.log("块 " + id + "：" + parsed.num + " → " + value);
        return true;
    }

    async getKramdown(id) {
        this.lastApi = "getBlockKramdown";
        const data = await api("/api/block/getBlockKramdown", {id: id});
        return data && typeof data.kramdown === "string" ? data.kramdown : "";
    }

    // 从一行的正文里找可累加的数字
    parseLine(line, attr) {
        const text = String(line || "");
        const hm = HEAD_RE.exec(text);
        const prefix = hm ? hm[1] + hm[2] : "";
        const body = text.slice(prefix.length);
        if (!body.trim()) {
            return null;
        }
        let hit = this.matchAny(body, this.getPatterns());
        if (!hit && attr) {
            hit = this.matchAny(body, [LOOSE_RE]);
        }
        if (!hit) {
            return null;
        }
        return {
            num: hit.num,
            start: prefix.length + hit.start,
            len: hit.len,
            name: hit.name,
            sep: hit.sep,
            unit: hit.unit,
            cap: hit.cap,
        };
    }

    matchAny(body, list) {
        for (let i = 0; i < list.length; i++) {
            const re = list[i];
            re.lastIndex = 0;
            const m = re.exec(body);
            if (!m) {
                continue;
            }
            const num = m[2];
            if (!num || !/^\d+$/.test(num)) {
                continue;
            }
            let from = 0;
            const name = m[1] || "";
            if (name && m[0].indexOf(name) === 0) {
                from = name.length;
            }
            const pos = m[0].indexOf(num, from);
            if (pos < 0) {
                continue;
            }
            const start = m.index + pos;
            const unit = m[3] || "";
            let cap = 0;
            const cm = CAP_RE.exec(unit);
            if (cm) {
                cap = parseInt(cm[1], 10) || 0;
            }
            return {
                num: parseInt(num, 10),
                name: name,
                sep: body.slice(m.index + name.length, start),
                unit: unit,
                cap: cap,
                start: start,
                len: num.length,
            };
        }
        return null;
    }

    /* ---------- 界面残留块检查（诊断命令） ---------- */

    // 整个界面（所有编辑器、面板、对话框）里的块 ID 一览
    domBlocksGlobal() {
        const map = new Map();
        const nodes = document.querySelectorAll("[data-node-id][data-type]");
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            const id = String(el.dataset.nodeId || "");
            if (!ID_RE.test(id) || map.has(id)) {
                continue;
            }
            map.set(id, {
                type: el.getAttribute("data-type") || "",
                text: String(el.textContent || "").slice(0, 50),
                ctx: this.contextOf(el),
            });
        }
        return map;
    }

    // 批量查库，返回其中真实存在的块 ID 集合
    async idsInDb(ids) {
        const exists = new Set();
        const chunk = 120;
        for (let i = 0; i < ids.length; i += chunk) {
            const part = ids.slice(i, i + chunk);
            const stmt = "SELECT id FROM blocks WHERE id IN ('" + part.join("','") + "')";
            const data = await api("/api/query/sql", {stmt: stmt});
            const rows = Array.isArray(data) ? data : [];
            rows.forEach(function (row) {
                if (row && row.id) {
                    exists.add(row.id);
                }
            });
        }
        return exists;
    }

    async scanPhantom() {
        const map = this.domBlocksGlobal();
        const ids = Array.from(map.keys());
        if (!ids.length) {
            showMessage(this.t("scanNone"), 3000, "info");
            return;
        }
        let exists;
        try {
            exists = await this.idsInDb(ids);
        } catch (e) {
            showMessage(this.t("failed") + "：" + (e && e.message ? e.message : e), 6000, "error");
            return;
        }
        const miss = [];
        const contexts = {};
        map.forEach(function (info, id) {
            contexts[info.ctx] = (contexts[info.ctx] || 0) + 1;
            if (!exists.has(id)) {
                miss.push({id: id, type: info.type, text: info.text, ctx: info.ctx});
            }
        });
        const ctxList = Object.keys(contexts).map(function (k) {
            return "   · " + k + "：" + contexts[k] + " 块";
        });
        if (!miss.length) {
            this.showText(this.t("scanTitle"), [
                "界面上的块 ID 共 " + ids.length + " 个，容器分布：",
                ctxList.join("\n"),
                "",
                "✅ 所有块在内核里都存在，没有临时块。",
            ].join("\n"));
            return;
        }
        const lines = [
            "界面上的块 ID 共 " + ids.length + " 个，容器分布：",
            ctxList.join("\n"),
            "",
            "ℹ 其中 " + miss.length + " 个只存在于界面、内核里没有（前端临时块）：",
            "",
        ];
        miss.forEach(function (info, i) {
            lines.push((i + 1) + ". " + info.id);
            lines.push("   位置=" + info.ctx);
            lines.push("   类型=" + info.type + "  文字=" + JSON.stringify(info.text));
        });
        lines.push("");
        lines.push("说明：这类块多来自智能体对话框（消息气泡/输入框）等前端临时渲染，属于正常现象，");
        lines.push("不会入库、也不用清理；本插件对它们一律跳过，不会报错。");
        this.showText(this.t("scanTitle"), lines.join("\n"));
    }

    /* ---------- 界面 ---------- */

    injectStyle() {
        const old = document.getElementById(STYLE_ID);
        if (old) {
            old.remove();
        }
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    flash(blockEl, positive) {
        try {
            const cls = positive ? "cc-flash-up" : "cc-flash-down";
            blockEl.classList.remove("cc-flash-up", "cc-flash-down");
            void blockEl.offsetWidth;
            blockEl.classList.add(cls);
            setTimeout(function () {
                if (blockEl && blockEl.classList) {
                    blockEl.classList.remove(cls);
                }
            }, 550);
        } catch (e) {
            // 忽略
        }
    }

    plain(text) {
        return String(text || "")
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/[*_~`{}]/g, "")
            .trim();
    }

    showText(title, text) {
        const dialog = new Dialog({
            title: title,
            content: '<div class="cc-dialog-body" style="height:100%;overflow:auto;padding:16px;' +
                'white-space:pre-wrap;font-size:12px;font-family:var(--b3-font-family-code)"></div>',
            width: "700px",
            height: "460px",
        });
        const body = dialog.element.querySelector(".cc-dialog-body");
        if (body) {
            body.textContent = text;
        }
    }

    checkbox() {
        const el = document.createElement("input");
        el.type = "checkbox";
        el.className = "b3-switch fn__flex-center";
        return el;
    }

    addSetting() {
        const elEnabled = this.checkbox();
        const elStep = document.createElement("input");
        elStep.type = "number";
        elStep.className = "b3-text-field fn__size100";
        const elPatterns = document.createElement("textarea");
        elPatterns.className = "b3-text-field fn__block";
        elPatterns.rows = 4;
        elPatterns.style.fontFamily = "var(--b3-font-family-code)";
        elPatterns.style.fontSize = "12px";
        const elFlash = this.checkbox();
        const elNotify = this.checkbox();
        const elDebug = this.checkbox();
        const self = this;

        this.setting = new Setting({
            confirmCallback: function () {
                self.cfg.enabled = elEnabled.checked;
                self.cfg.step = self.normStep(elStep.value);
                self.cfg.patterns = elPatterns.value;
                self.cfg.flash = elFlash.checked;
                self.cfg.notify = elNotify.checked;
                self.cfg.debug = elDebug.checked;
                self.patternCache = {source: null, list: []};
                self.saveCfg();
            },
        });

        this.setting.addItem({
            title: this.t("enableTitle"),
            description: this.t("enableDesc"),
            createActionElement: function () {
                elEnabled.checked = !!self.cfg.enabled;
                return elEnabled;
            },
        });
        this.setting.addItem({
            title: this.t("stepTitle"),
            description: this.t("stepDesc"),
            createActionElement: function () {
                elStep.value = String(self.cfg.step);
                return elStep;
            },
        });
        this.setting.addItem({
            title: this.t("patternTitle"),
            description: this.t("patternDesc"),
            direction: "column",
            createActionElement: function () {
                elPatterns.value = String(self.cfg.patterns || "");
                return elPatterns;
            },
        });
        this.setting.addItem({
            title: this.t("flashTitle"),
            description: this.t("flashDesc"),
            createActionElement: function () {
                elFlash.checked = !!self.cfg.flash;
                return elFlash;
            },
        });
        this.setting.addItem({
            title: this.t("notifyTitle"),
            description: this.t("notifyDesc"),
            createActionElement: function () {
                elNotify.checked = !!self.cfg.notify;
                return elNotify;
            },
        });
        this.setting.addItem({
            title: this.t("debugTitle"),
            description: this.t("debugDesc"),
            createActionElement: function () {
                elDebug.checked = !!self.cfg.debug;
                return elDebug;
            },
        });
    }

    openSetting() {
        if (!this.setting) {
            this.addSetting();
        }
        this.setting.open(this.t("settingTitle"));
    }

    /* ---------- 诊断 ---------- */

    async diagnose() {
        const el = this.blockAtCursor();
        if (!el) {
            showMessage(this.t("noBlock"), 3000, "info");
            return;
        }
        const id = el.dataset ? String(el.dataset.nodeId || "") : "";
        const attr = String(el.getAttribute(ATTR) || "").trim();
        let exists = false;
        try {
            exists = await this.blockExists(id);
        } catch (e) {
            // 查不通就当作存在
            exists = true;
        }
        let kramdown = "";
        let error = "";
        if (exists) {
            try {
                kramdown = await this.getKramdown(id);
            } catch (e) {
                error = e && e.message ? e.message : String(e);
            }
        } else {
            error = "该块不在内核中（前端临时块）";
        }
        const first = (kramdown || "").split("\n")[0] || "";
        const parsed = this.parseLine(first, attr);
        const lines = [
            "所在位置：" + this.contextOf(el),
            "块 ID：" + id + (ID_RE.test(id) ? "" : "（形态不对！）"),
            "块类型：" + (el.getAttribute("data-type") || ""),
            "块文字：" + JSON.stringify(String(el.textContent || "").slice(0, 60)),
            "内核中存在：" + (exists ? "是" : "否（前端临时块，不计数）"),
            "块属性 " + ATTR + "：" + (attr || "（无）"),
            "首行 kramdown：" + (first || "（空）"),
            "取块报错：" + (error || "（无）"),
            "启用状态：" + (this.cfg.enabled ? "已启用" : "已停用"),
            "当前步长：" + this.cfg.step,
            "规则条数：" + this.getPatterns().length,
            "匹配结果：" + (parsed
                ? "命中 → " + this.plain(parsed.name) + parsed.sep + parsed.num + parsed.unit +
                    (parsed.cap > 0 ? "（上限 " + parsed.cap + "）" : "")
                : "未命中（不计数）"),
            "",
            "提示：双击计数（到目标值封顶），单击正常编辑；按住 Alt 双击不计数；规则可在插件设置里改。",
        ];
        this.showText(this.t("diagnoseTitle"), lines.join("\n"));
    }
}

module.exports = ClickCounter;
