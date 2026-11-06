window.__ModuleLoader__.load({
	id: "@luna/dsh-minimax-tts",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

/**
 * @luna/dsh-minimax-tts — 浏览器半 v0.1
 *
 * 挂在 `conversation.chat.assistant-actions`：每条已完成的助手回复多一个
 * 「朗读」按钮。点一下 → 宿主合成 → 浏览器播放；再点一下停止。
 *
 * ⚠️ 这个槽只给 `messageId`，不给正文。所以这里只负责把 id 发给宿主，
 *    正文由宿主从会话日志里取（见 lib/index.js 的 textForMessage）。
 *
 * 红线：
 *   ❌ 不在客户端读取或拼接消息正文（拿不到，也不该拿）。
 *   ❌ 不注册 single seat（只往 list 型槽里加自己的格子）。
 */

var react = require("react");

var API = "/luna-tts/speak";
var CSS_ID = "luna-tts-action-css";

var CSS =
	".ltts-btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm);" +
	"border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);" +
	"font-family:var(--dsw-font-family);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;" +
	"transition:background .12s,border-color .12s,color .12s}" +
	".ltts-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);" +
	"border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}" +
	".ltts-btn:disabled{opacity:.55;cursor:default}" +
	".ltts-btn[data-state=playing]{color:var(--dsw-alias-brand-primary,var(--color-blue-500));" +
	"border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--color-blue-500)) 45%,transparent)}" +
	".ltts-btn svg{flex:none;display:block}" +
	".ltts-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;" +
	"animation:ltts-pulse 1s ease-in-out infinite}" +
	"@keyframes ltts-pulse{0%,100%{opacity:.25}50%{opacity:1}}";

function ensureCss() {
	try {
		if (typeof document === "undefined") return;
		if (document.querySelector("style[data-luna-tts-css]") !== null) return;
		var style = document.createElement("style");
		style.dataset.lunaTtsCss = "1";
		style.id = CSS_ID;
		style.textContent = CSS;
		document.head.appendChild(style);
	} catch (error) {
		/* 样式失败不影响功能 */
	}
}

var ICON_SPEAKER = react.createElement(
	"svg",
	{ width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
	react.createElement("path", {
		d: "M8.5 2.2 4.9 5.1H2.6a.6.6 0 0 0-.6.6v4.6c0 .33.27.6.6.6h2.3l3.6 2.9a.5.5 0 0 0 .8-.4V2.6a.5.5 0 0 0-.8-.4Z",
		fill: "currentColor"
	}),
	react.createElement("path", {
		d: "M11.3 5.4a3.4 3.4 0 0 1 0 5.2M13.2 3.6a6 6 0 0 1 0 8.8",
		stroke: "currentColor",
		strokeWidth: 1.2,
		strokeLinecap: "round"
	})
);

var ICON_STOP = react.createElement(
	"svg",
	{ width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
	react.createElement("rect", { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1.6, fill: "currentColor" })
);

/** 一条助手回复的朗读按钮。props 至少含 messageId / sessionId。 */
function SpeakAction(props) {
	var messageId = props === null || props === undefined ? undefined : props.messageId;
	var sessionId = props === null || props === undefined ? undefined : props.sessionId;

	var stateHook = react.useState("idle");
	var phase = stateHook[0];
	var setPhase = stateHook[1];

	var errHook = react.useState(null);
	var error = errHook[0];
	var setError = errHook[1];

	var audioRef = react.useRef(null);
	var urlRef = react.useRef(null);
	var aliveRef = react.useRef(true);

	react.useEffect(function () {
		ensureCss();
		aliveRef.current = true;
		return function () {
			aliveRef.current = false;
			teardown();
		};
	}, []);

	function teardown() {
		try {
			var audio = audioRef.current;
			if (audio !== null) {
				audio.pause();
				audio.onended = null;
				audio.onerror = null;
				audio.src = "";
			}
		} catch (cleanupError) {
			/* ignore */
		}
		audioRef.current = null;
		try {
			if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
		} catch (revokeError) {
			/* ignore */
		}
		urlRef.current = null;
	}

	function stop() {
		teardown();
		if (aliveRef.current) setPhase("idle");
	}

	function click() {
		if (phase === "playing") {
			stop();
			return;
		}
		if (phase === "loading") return;

		setError(null);
		setPhase("loading");

		var request = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: sessionId, messageId: messageId })
		};

		fetch(API, request)
			.then(function (response) {
				if (!response.ok) {
					return response
						.json()
						.catch(function () {
							return { error: "HTTP " + response.status };
						})
						.then(function (payload) {
							throw new Error((payload && payload.error) || "合成失败");
						});
				}
				return response.blob();
			})
			.then(function (blob) {
				if (!aliveRef.current) return;
				var url = URL.createObjectURL(blob);
				urlRef.current = url;
				var audio = new Audio(url);
				audioRef.current = audio;
				audio.onended = function () {
					teardown();
					if (aliveRef.current) setPhase("idle");
				};
				audio.onerror = function () {
					teardown();
					if (aliveRef.current) {
						setError("播放失败");
						setPhase("idle");
					}
				};
				setPhase("playing");
				var playing = audio.play();
				if (playing !== undefined && typeof playing.catch === "function") {
					playing.catch(function (playError) {
						teardown();
						if (aliveRef.current) {
							setError(String((playError && playError.message) || playError));
							setPhase("idle");
						}
					});
				}
			})
			.catch(function (failure) {
				if (!aliveRef.current) return;
				setError(String((failure && failure.message) || failure));
				setPhase("idle");
			});
	}

	var label = phase === "playing" ? "停止" : phase === "loading" ? "合成中" : "朗读";
	var icon = phase === "playing" ? ICON_STOP : ICON_SPEAKER;
	var title = error === null ? label + "这条回复（MiniMax female-shaonv）" : "上次失败：" + error;

	var children = [icon, react.createElement("span", { key: "t" }, label)];
	if (phase === "loading") {
		children.push(react.createElement("span", { key: "d", className: "ltts-dot" }));
	}

	return react.createElement(
		"button",
		{
			type: "button",
			className: "ltts-btn",
			"data-state": phase,
			disabled: phase === "loading",
			title: title,
			onClick: click
		},
		children
	);
}

var inject = ["slots"];

function apply(ctx) {
	ctx.slots.inject("conversation.chat.assistant-actions", function () {
		return ctx.slots.register(
			{
				name: "conversation.chat.assistant-actions",
				id: "luna-tts",
				order: 15
			},
			SpeakAction
		);
	});
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
