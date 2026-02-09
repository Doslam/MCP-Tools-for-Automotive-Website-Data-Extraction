/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {Frame, JSHandle, Page} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';


console.error('[MCP] extract_dcd_by_url loaded');

export const evaluateScript = defineTool({
  name: 'evaluate_script',
  description: `Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    function: zod.string().describe(
      `A JavaScript function declaration to be executed by the tool in the currently selected page.
Example without arguments: \`() => {
  return document.title
}\` or \`async () => {
  return await fetch("example.com")
}\`.
Example with arguments: \`(el) => {
  return el.innerText;
}\`
`,
    ),
    args: zod
      .array(
        zod.object({
          uid: zod
            .string()
            .describe(
              'The uid of an element on the page from the page content snapshot',
            ),
        }),
      )
      .optional()
      .describe(`An optional list of arguments to pass to the function.`),
  },
  handler: async (request, response, context) => {
    const args: Array<JSHandle<unknown>> = [];
    try {
      const frames = new Set<Frame>();
      for (const el of request.params.args ?? []) {
        const handle = await context.getElementByUid(el.uid);
        frames.add(handle.frame);
        args.push(handle);
      }
      let pageOrFrame: Page | Frame;
      // We can't evaluate the element handle across frames
      if (frames.size > 1) {
        throw new Error(
          "Elements from different frames can't be evaluated together.",
        );
      } else {
        pageOrFrame = [...frames.values()][0] ?? context.getSelectedPage();
      }
      const fn = await pageOrFrame.evaluateHandle(
        `(${request.params.function})`,
      );
      args.unshift(fn);
      await context.waitForEventsAfterAction(async () => {
        const result = await pageOrFrame.evaluate(
          async (fn, ...args) => {
            // @ts-expect-error no types.
            return JSON.stringify(await fn(...args));
          },
          ...args,
        );
        response.appendResponseLine('Script ran on page and returned:');
        response.appendResponseLine('```json');
        response.appendResponseLine(`${result}`);
        response.appendResponseLine('```');
      });
    } finally {
      void Promise.allSettled(args.map(arg => arg.dispose()));
    }
  },
});




export const extractDcdByUrl = defineTool({
  name: 'extract_dcd_by_url',
  description:
    'Use this tool when a user asks to extract, analyze, or summarize a community post and its comments from one or more given dongchedi URL. This tool opens URL in a new page, runs the pre-defined extraction script, and return JSON result.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    url: zod.string().optional().describe('Target URL to open before running the extraction script'),
    urls: zod.array(zod.string()).optional().describe('Target URLs to open before running the extraction script, must be an array of strings'),
  },
  handler: async (request, response, context) => {
    // 1) normalize input to string[]
    const page = await context.newPage(false); 
    const urls: string[] = Array.isArray(request.params.urls)
      ? request.params.urls.filter(Boolean)
      : (request.params.url ? [request.params.url] : []);

    if (!urls.length) {
      response.appendResponseLine("```json");
      response.appendResponseLine(JSON.stringify({ error: "Missing url(s). Provide `url` or `urls`." }, null, 2));
      response.appendResponseLine("```");
      return;
    }

    const results : any[] = []
    for (const url of urls){
      await context.waitForEventsAfterAction(async () => { 
      await page.goto(url, { timeout: 60000 }); });

    const one = await page.evaluate(async () => {
      // ========= utils =========
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const norm = (s: any) => (s || "").toString().replace(/\s+/g, " ").trim();
      const getText = (el: any) => norm(el?.innerText || el?.textContent || "");
      const hrefAbs = (a: any) =>
        a ? new URL((a as Element).getAttribute("href") || "", location.origin).toString() : "";

      // ========= image helpers =========
      const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);
      const isDataUrl = (u: string) => /^data:/i.test(u);
      const isImageExt = (u: string) => /\.(jpe?g|png|webp)(\?|#|$)/i.test(u);

      // 你举的两类图都在 toutiaoimg / byteimg 生态里（更稳）
      const isLikelyRealCdnImage = (u: string) => {
        try {
          const url = new URL(u);
          const host = url.hostname;
          // 允许 toutiaoimg / byteimg 及其子域
          const okHost =
            host.endsWith("toutiaoimg.com") ||
            host.endsWith("byteimg.com");
          return okHost && isImageExt(u);
        } catch {
          return false;
        }
      };

      // ========= next page =========
      async function goNextPage(): Promise<boolean> {
        const icon = document.querySelector(
          "i.DCD_Icon.icon_into_12"
        ) as HTMLElement | null;

        if (!icon) return false;

        const link = icon.closest("a") as HTMLElement | null;
        if (!link) return false;

        try {
          link.scrollIntoView({ block: "center" });
          link.click();
          return true;
        } catch {
          return false;
        }
      }


      // ========= extract image =========
      function extractImages(container: Element | null): string[] {
        if (!container) return [];

        const toAbs = (u: string) => {
          if (!u) return "";
          try { return new URL(u, location.origin).toString(); } catch { return u; }
        };

        const raw = Array.from(container.querySelectorAll("img"))
          .map((img) => {
            const el = img as HTMLImageElement;
            return (
              el.getAttribute("src") ||
              el.getAttribute("data-src") ||
              el.getAttribute("data-original") ||
              el.getAttribute("data-lazy-src") ||
              el.currentSrc ||
              ""
            );
          })
          .map((u) => toAbs(u))
          .map((u) => (u || "").trim())
          .filter(Boolean);

        // ✅ 过滤掉：data:image/svg+xml;base64,... 之类的占位
        // ✅ 只保留：http(s) 且 jpg/png/webp 且域名在 toutiaoimg/byteimg（与你需求一致）
        const filtered = raw.filter((u) => {
          if (!u) return false;
          if (isDataUrl(u)) return false;                 // 干掉 data:（包括 svg base64）
          if (!isHttpUrl(u)) return false;                // 只要 http(s)
          if (!isLikelyRealCdnImage(u)) return false;      // 只留真实 cdn 图（含 jpg/png/webp）
          return true;
        });

        // 去重
        const seen = new Set<string>();
        const out: string[] = [];
        for (const u of filtered) {
          if (seen.has(u)) continue;
          seen.add(u);
          out.push(u);
        }
        return out;
      }

      // ========= extract video =========
      function extractVideos(container: Element | null): string[] {
        if (!container) return [];

        const toAbs = (u: string) => {
          if (!u) return "";
          try { return new URL(u, location.origin).toString(); } catch { return u; }
        };

        const raw = Array.from(container.querySelectorAll("video"))
          .map((video) => {
            const el = video as HTMLVideoElement;
            return (el.getAttribute("src") || "");
          })
          .map((u)=>toAbs(u))
          .map((u) => (u || "").trim())
          .filter(Boolean);

        const out :  string[] = [];
        for (const u of raw) {
          if (!u) continue;
          if (!isHttpUrl(u)) continue;
          out.push(u);
        }
        return out;
      }

      // ========= expand =========
      function isVisible(el: Element | null) {
        const r = (el as HTMLElement | null)?.getBoundingClientRect?.();
        return !!(r && r.width > 0 && r.height > 0);
      }

      function findExpandButtons(): HTMLElement[] {
        return Array.from(document.querySelectorAll("button.tw-text-common-blue"))
          .filter((b) => isVisible(b))
          .filter((b) => {
            const t = getText(b);
            if (!t) return false;
            if (t.includes("收起")) return false;
            return t.includes("条回复") || t.includes("全部") || t.includes("展开") || t.includes("更多");
          })
          .map((b) => b as HTMLElement);
      }

      async function clickAllExpands(rounds = 10) {
        for (let i = 0; i < rounds; i++) {
          const btns = findExpandButtons();
          if (!btns.length) break;

          const seen = new Set<string>();
          for (const b of btns) {
            const key = (b.outerHTML || "").slice(0, 180);
            if (seen.has(key)) continue;
            seen.add(key);
            try {
              b.scrollIntoView({ block: "center" });
              b.click();
              await sleep(40);
            } catch {}
          }
        }
      }

      async function autoScroll({ maxLoops = 60, pauseMs = 220, stableRounds = 5,bottomGapPx = 1200 } = {}) {
        let stable = 0;
        let lastH = 0;
        for (let i = 0; i < maxLoops; i++) {
          window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.9)));
          await sleep(pauseMs);
          await clickAllExpands(2);
          // 4) 判断是否到底/是否还在增长
          const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
          const y = window.scrollY + window.innerHeight;
          const nearBottom = y >= h - bottomGapPx;

          if (h === lastH) stable++;
          else stable = 0;

          lastH = h;

          // 连续 stableRounds 次不增长，并且接近底部 => 停
          if (stable >= stableRounds && nearBottom) break;
        }
      }

      // ========= post =========
      function extractPost() {
        const authorA = document.querySelector('p.tw-truncate a[href^="/user/"]') as HTMLAnchorElement | null;
        const timeP = document.querySelector("div.user p") as HTMLElement | null;
        const contentSpan = document.querySelector("div.content p.article-content span") as HTMLElement | null;
        const contentDiv = document.querySelector("div.content") as HTMLElement | null;

        const timeRaw = getText(timeP);
        let date = "", publishedTo = "";
        if (timeRaw) {
          const m = timeRaw.match(/^(\d{2}-\d{2})/);
          if (m) date = m[1];
          const idx = timeRaw.indexOf("发布于：");
          if (idx >= 0) publishedTo = timeRaw.slice(idx + "发布于：".length).trim();
        }

        const postRoot =
          contentDiv?.closest("div[class*='content']")?.parentElement ||
          contentDiv?.parentElement ||
          document.body;

        return {
          author: getText(authorA),
          authorUrl: authorA ? hrefAbs(authorA) : "",
          timeRaw,
          date,
          publishedTo,
          content: getText(contentSpan) || getText(contentDiv),
          images: extractImages(postRoot),
          videos: extractVideos(postRoot),
        };
      }

      // ========= id parser =========
      function parseDataLogView(card: Element | null) {
        let groupId = "", commentId = "";
        const dlv = card?.getAttribute?.("data-log-view");
        if (!dlv) return { groupId, commentId };

        const fixed = dlv.includes("&quot;") ? dlv.replace(/&quot;/g, '"') : dlv;

        try {
          const obj = JSON.parse(fixed);
          groupId = obj?.params?.group_id || "";
          commentId = obj?.params?.comment_id || "";
          return { groupId, commentId };
        } catch {}

        const m1 = fixed.match(/group_id"\s*:\s*"(\d+)"/);
        const m2 = fixed.match(/comment_id"\s*:\s*"(\d+)"/);
        if (m1) groupId = m1[1];
        if (m2) commentId = m2[1];
        return { groupId, commentId };
      }

      // ========= find thread roots =========
      function findThreadRoots(): Element[] {
        const roots: Element[] = [];
        const candidates = Array.from(document.querySelectorAll("div.tw-flex"));

        for (const root of candidates) {
          const left = root.querySelector(":scope > div.tw-w-232");
          const right = root.querySelector(":scope > div.tw-flex-1");
          if (!left || !right) continue;

          const mainCard = right.querySelector("section.community-card[data-log-view]");
          if (!mainCard) continue;

          const hasCommentMeta = Array.from(right.querySelectorAll("span.tw-text-video-shallow-gray"))
            .some((sp) => getText(sp).includes("评论发表于"));

          const hasReplyList = !!right.querySelector("ul > li");
          if (!hasCommentMeta && !hasReplyList) continue;

          const len = getText(right).length;
          if (len < 5 || len > 15000) continue;

          roots.push(root);
        }

        // 去重
        const out: Element[] = [];
        const seen = new Set<string>();
        for (const r of roots) {
          const right = r.querySelector(":scope > div.tw-flex-1");
          const mainCard = right?.querySelector("section.community-card[data-log-view]") || null;
          const { commentId } = parseDataLogView(mainCard);
          const key = commentId ? `cid:${commentId}` : (r.outerHTML || "").slice(0, 140);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(r);
        }
        return out;
      }

      // ========= extract threads + replies =========
      function extractThreadedComments() {
        const roots = findThreadRoots();
        const threads: any[] = [];

        for (const root of roots) {
          const left = root.querySelector(":scope > div.tw-w-232") as HTMLElement | null;
          const right = root.querySelector(":scope > div.tw-flex-1") as HTMLElement | null;
          if (!left || !right) continue;

          const authorA = left.querySelector("p.tw-truncate a[href^='/user/']") as HTMLAnchorElement | null;
          const author = getText(authorA);
          const authorUrl = authorA ? hrefAbs(authorA) : "";

          const isOP = Array.from(left.querySelectorAll("span")).some((sp) => getText(sp).includes("楼主"));

          const mainCard = right.querySelector("section.community-card[data-log-view]");
          const mainContentSpan = mainCard?.querySelector("span.tw-text-common-black") as HTMLElement | null;
          const content = getText(mainContentSpan);

          let timeRaw = "";
          for (const sp of Array.from(right.querySelectorAll("span.tw-text-video-shallow-gray"))) {
            const t = getText(sp);
            if (t.includes("评论发表于")) { timeRaw = t; break; }
          }

          const { groupId, commentId } = parseDataLogView(mainCard);

          const topImages = extractImages(right);

          const topvideos = extractVideos(right);

          // ✅ 关键修复：只抓第一层 replies 的 li，避免把嵌套 li 全抓进来
          const replyLis = Array.from(right.querySelectorAll(":scope > ul > li")) as HTMLElement[];

          const replies: any[] = [];
          const replySeen = new Set<string>(); // ✅ commentId 去重

          for (const li of replyLis) {
            const replyOuter =
              (li.querySelector(":scope section.community-card[data-log-view]") ||
                li.querySelector("section.community-card[data-log-view]")) as HTMLElement | null;
            if (!replyOuter) continue;

            const { commentId: replyCommentId } = parseDataLogView(replyOuter);

            const dedupeKey =
              replyCommentId ? `rid:${replyCommentId}` : (li.outerHTML || "").slice(0, 180);
            if (replySeen.has(dedupeKey)) continue;
            replySeen.add(dedupeKey);

            const replyAuthorLink = replyOuter.querySelector(":scope a[href^='/user/']") as HTMLAnchorElement | null;
            const replyAuthor =
              getText(replyOuter.querySelector(":scope a[href^='/user/'] span.tw-text-black")) ||
              getText(replyAuthorLink);
            const replyAuthorUrl = replyAuthorLink ? hrefAbs(replyAuthorLink) : "";

            const inner = (li.querySelector(":scope section.tw-pl-56") as HTMLElement | null) || li;

            let replyContent = getText(inner.querySelector("span.tw-text-common-black"));
            if (!replyContent) {
              const spans = Array.from(inner.querySelectorAll("span.tw-text-common-black"))
                .filter((sp) => !(sp as HTMLElement).closest("div.jsx-1055894087"));
              replyContent = getText(spans[0] as any);
            }

            let replyTimeRaw = "";
            for (const sp of Array.from(inner.querySelectorAll("span.tw-text-video-shallow-gray"))) {
              const t = getText(sp);
              if (t.includes("回复发表于") || t.includes("回发表于")) { replyTimeRaw = t; break; }
            }

            if (replyAuthor && replyContent) {
              replies.push({
                commentId: replyCommentId,
                author: replyAuthor,
                authorUrl: replyAuthorUrl,
                timeRaw: replyTimeRaw,
                content: replyContent,
                images: extractImages(li), // ✅ 回复图通常在 li 内
                videos: extractVideos(li),
              });
            }
          }

          if (!author || !content) continue;

          threads.push({
            groupId,
            commentId,
            isOP,
            author,
            authorUrl,
            timeRaw,
            content,
            images: topImages,
            videos: topvideos,
            replies,
          });
        }

        return threads;
      }

      // ========= run =========
      const allcomments : any[] = [];
      
      while(true) { 
        await clickAllExpands(5);
        await autoScroll({ maxLoops: 22, pauseMs: 220 });
        await clickAllExpands(5);
        
        const comments = extractThreadedComments();
        allcomments.push(...comments);
        const cangonextpage = await goNextPage();
        if (!cangonextpage){break};
      }
      const post = extractPost();

      const totalImgsOnPage = document.querySelectorAll("img").length;

      return {
        url: location.href,
        extractedAt: new Date().toISOString(),
        post,
        allcomments,
      };
        // debug: {
        //   totalImgsOnPage,
        //   postImages: post.images.length,
        //   threadWithImages: comments.filter((t) => (t.images?.length || 0) > 0).length,
        // },
      //};  
    
    
  });
  results.push(one)
}
    //response.appendResponseLine("```json");
    response.appendResponseLine(JSON.stringify(results, null, 2));
    //response.appendResponseLine("```");
    
},

});


















export const extract_qczj_by_url = defineTool({
  name: 'extract_qczj_by_url',
  description:
    'Use this tool when a user asks to extract, analyze, or summarize a community post and its comments from one or more given autohome URL. This tool opens URL in a new page, runs the pre-defined extraction script, and return JSON result.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    url: zod.string().optional().describe('Target URL to open before running the extraction script'),
    urls: zod.array(zod.string()).optional().describe('Target URLs to open before running the extraction script, must be an array of strings'),
  },
  handler: async (request, response, context) => {
    // 1) normalize input to string[]
    const page = await context.newPage(false); 
    const urls: string[] = Array.isArray(request.params.urls)
      ? request.params.urls.filter(Boolean)
      : (request.params.url ? [request.params.url] : []);

    if (!urls.length) {
      response.appendResponseLine("```json");
      response.appendResponseLine(JSON.stringify({ error: "Missing url(s). Provide `url` or `urls`." }, null, 2));
      response.appendResponseLine("```");
      return;
    }

    const results : any[] = []
    const clean = (u:string) => { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString(); };
    for (let url of urls.map(clean)){
      await context.waitForEventsAfterAction(async () => { 
      await page.goto(url, { timeout: 60000 }); });

      
    
    const lord = await page.evaluate(async () => {
      // ========= utils =========
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const norm = (s: any) => (s || "").toString().replace(/\s+/g, " ").trim();
      const getText = (el: any) => norm(el?.innerText || el?.textContent || "b");
      const hrefAbs = (a: any) =>
        a ? new URL((a as Element).getAttribute("href") || "", location.origin).toString() : "";

      // ========= image helpers =========
      const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);
      const isDataUrl = (u: string) => /^data:/i.test(u);
      


      // ========= extract image =========
      function extractImages(container: Element | null): string[] {
        if (!container) return [];

        function toAbs(u: string) {
  if (!u) return "";
  u = u.trim();
  if (/^\/\//.test(u)) return "https:" + u; // //xxx -> https://xxx
  try { return new URL(u, location.origin).toString(); } catch { return u; }
}

        const raw = Array.from(container.querySelectorAll("img"))
          .map((img) => {
            const el = img as HTMLImageElement;
            return (
              el.getAttribute("src") ||
              el.getAttribute("data-src") ||
              el.getAttribute("data-original") ||
              el.getAttribute("data-lazy-src") ||
              el.currentSrc ||
              ""
            );
          })
          .map((u) => (u || "").trim())
          .map(toAbs)
          .filter(Boolean);

        // ✅ 过滤掉：data:image/svg+xml;base64,... 之类的占位
        // ✅ 只保留：http(s) 且 jpg/png/webp 且域名在 toutiaoimg/byteimg（与你需求一致）
        const filtered = raw.filter((u) => {
          if (!u) return false;
          if (u.includes("z.autoimg.cn/bbs/pc/detail/img/topic-blank.png")) return false;
          if (!(
    u.includes("jpg") ||
    u.includes("webp") ||
    u.includes("png")
  )) return false;
          if (isDataUrl(u)) return false;                 // 干掉 data:（包括 svg base64）
          return true;
        });

        // 去重
        const seen = new Set<string>();
        const out: string[] = [];
        for (const u of filtered) {
          if (seen.has(u)) continue;
          seen.add(u);
          out.push(u);
        }
        return out;
      }

      // ========= extract video =========
      function extractVideos(container: Element | null): string[] {
        if (!container) return [];

        const toAbs = (u: string) => {
          if (!u) return "";
          try { return new URL(u, location.origin).toString(); } catch { return u; }
        };

        const raw = Array.from(container.querySelectorAll("video"))
          .map((video) => {
            const el = video as HTMLVideoElement;
            return (el.getAttribute("src") || "");
          })
          .map((u)=>toAbs(u))
          .map((u) => (u || "").trim())
          .filter(Boolean);

        const out :  string[] = [];
        for (const u of raw) {
          if (!u) continue;
          if (!isHttpUrl(u)) continue;
          out.push(u);
        }
        return out;
      }

      

      async function autoScroll({ maxLoops = 60, pauseMs = 220, stableRounds = 5,bottomGapPx = 1200 } = {}) {
        let stable = 0;
        let lastH = 0;
        for (let i = 0; i < maxLoops; i++) {
          window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.55)));
          await sleep(pauseMs);
          // 4) 判断是否到底/是否还在增长
          const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
          const y = window.scrollY + window.innerHeight;
          const nearBottom = y >= h - bottomGapPx;

          if (h === lastH) stable++;
          else stable = 0;

          lastH = h;

          // 连续 stableRounds 次不增长，并且接近底部 => 停
          if (stable >= stableRounds && nearBottom) break;
        }
      }

      

      // ========= post =========
      function extractPost() {
        
        const landlord = document.querySelector("div.post-wrap") || document.querySelector("div.post") as HTMLElement | null;
        if (!landlord) return null;
        const authorA = landlord.querySelector("div.user-info div.user-name a.name")||landlord.querySelector("div.post-user div.user-brief-name a.name") as HTMLAnchorElement | null;
        const landlordcontent = document.querySelector("div.post") as HTMLElement | null;
        if (!landlordcontent) return null;
        const title = landlordcontent.querySelector("div.post-title") as HTMLElement | null;
        const timeP = landlordcontent.querySelector("span.post-handle-publish")||landlordcontent.querySelector("div.post-info") as HTMLElement | null;
        const contentSpan = landlordcontent.querySelector("div.post-container") as HTMLElement;
        //const contentDiv = document.querySelector("div.content") as HTMLElement | null;

        const timeRaw = getText(timeP);
        let date = "";
        if (timeRaw) {
          const m = timeRaw.match(/(\d{4}-\d{2}-\d{2})/);
          if (m) date = m[1];
        }

        
        
        return {
          author: getText(authorA),
          authorUrl: authorA ? hrefAbs(authorA) : "",
          timeRaw : getText(timeP),
          date,
          title : getText(title),
          content: getText(contentSpan),
          images: extractImages(contentSpan),
          videos: extractVideos(landlord.querySelector("div.post-video")),
        };
      }
      
      
      await autoScroll({ maxLoops: 14, pauseMs: 200 });
      await sleep(500)

      const post = extractPost();
      return post
        // debug: {
        //   totalImgsOnPage,
        //   postImages: post.images.length,
        //   threadWithImages: comments.filter((t) => (t.images?.length || 0) > 0).length,
        // },
      //};  
      });
      const comments : any[] = []
      let index = 1
    while (true) {
      
      const comment = await page.evaluate(async() => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const norm = (s: any) => (s || "").toString().replace(/\s+/g, " ").trim();
      const getText = (el: any) => norm(el?.innerText || el?.textContent || "");
      const hrefAbs = (a: any) =>
        a ? new URL((a as Element).getAttribute("href") || "", location.origin).toString() : "";

      // ========= image helpers =========
      const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);
      const isDataUrl = (u: string) => /^data:/i.test(u);
      const isImageExt = (u: string) => /\.(jpe?g|png|webp)(\?|#|$)/i.test(u);

      // ========= extract image =========
      function extractImages(container: Element | null): string[] {
        if (!container) return [];

        const toAbs = (u: string) => {
          if (!u) return "";
          try { return new URL(u, "https:").toString(); } catch { return u; }
        };

        const raw = Array.from(container.querySelectorAll("img"))
          .map((img) => {
            const el = img as HTMLImageElement;
            return (
              el.getAttribute("src") ||
              el.getAttribute("data-src") ||
              el.getAttribute("data-original") ||
              el.getAttribute("data-lazy-src") ||
              el.currentSrc ||
              ""
            );
          })
          .map((u) => toAbs(u))
          .map((u) => (u || "").trim())
          .filter(Boolean);

        // ✅ 过滤掉：data:image/svg+xml;base64,... 之类的占位
        // ✅ 只保留：http(s) 且 jpg/png/webp 且域名在 toutiaoimg/byteimg（与你需求一致）
        const filtered = raw.filter((u) => {
          if (!u) return false;
          if (u.includes("z.autoimg.cn/bbs/pc/detail/img/topic-blank.png")) return false;
          if (!(
    u.includes("jpg") ||
    u.includes("webp") ||
    u.includes("png")
  )) return false;
          if (u.includes("emoji")) return false;
          if (isDataUrl(u)) return false;                 // 干掉 data:（包括 svg base64）
          return true;
        });

        // 去重
        const seen = new Set<string>();
        const out: string[] = [];
        for (const u of filtered) {
          if (seen.has(u)) continue;
          seen.add(u);
          out.push(u);
        }
        return out;
      }

      // ========= extract video =========
      function extractVideos(container: Element | null): string[] {
        if (!container) return [];

        const toAbs = (u: string) => {
          if (!u) return "";
          try { return new URL(u, location.origin).toString(); } catch { return u; }
        };

        const raw = Array.from(container.querySelectorAll("video"))
          .map((video) => {
            const el = video as HTMLVideoElement;
            return (el.getAttribute("src") || "");
          })
          .map((u)=>toAbs(u))
          .map((u) => (u || "").trim())
          .filter(Boolean);

        const out :  string[] = [];
        for (const u of raw) {
          if (!u) continue;
          if (!isHttpUrl(u)) continue;
          out.push(u);
        }
        return out;
      }

      // ========= expand =========
      function isVisible(el: Element | null) {
        const r = (el as HTMLElement | null)?.getBoundingClientRect?.();
        return !!(r && r.width > 0 && r.height > 0);
      }

      function findExpandButtons(expandblock = "span.js-comment-loadmore"): HTMLElement[] {
        return Array.from(document.querySelectorAll(expandblock))
          .filter((b) => isVisible(b))
          .filter((b) => {
            const t = getText(b);
            if (!t) return false;
            if (t.includes("收起")) return false;
            return t.includes("查看更多评论")|| t.includes("展开");
          })
          .map((b) => b as HTMLElement);
      }

      
      async function clickAllExpands(rounds = 10) {
        for (let i = 0; i < rounds; i++) {
          const btns = findExpandButtons();
          if (!btns.length) break;

          //const seen = new Set<string>();
          for (const b of btns) {
            // const key = (b.outerHTML || "").slice(0, 180);
            // if (seen.has(key)) continue;
            // seen.add(key);
            try {
              b.scrollIntoView({ block: "center" });
              await sleep(1500);
              b.click();
              await sleep(500);
              
              
            } catch {}
          }
          const subbtns = findExpandButtons("div.reply-sub-front span.unfold-comment i");
          if (!subbtns.length) continue;
                for (const subb of subbtns) {
                  subb.scrollIntoView({ block: "center" });
                  await sleep(1000);
                  subb.click();
                  await sleep(500);
                }
        }
      }

      async function autoScroll({ maxLoops = 60, pauseMs = 220, stableRounds = 5,bottomGapPx = 1200 } = {}) {
        let stable = 0;
        let lastH = 0;
        for (let i = 0; i < maxLoops; i++) {
          window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.7)));
          await sleep(pauseMs);
          
          // 4) 判断是否到底/是否还在增长
          const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
          const y = window.scrollY + window.innerHeight;
          const nearBottom = y >= h - bottomGapPx;

          if (h === lastH) stable++;
          else stable = 0;

          lastH = h;

          // 连续 stableRounds 次不增长，并且接近底部 => 停
          if (stable >= stableRounds && nearBottom) break;
        }
      }


      // ========= extract threads + replies =========
      function extractThreadedComments() {
        const roots = Array.from(document.querySelectorAll("li.js-reply-floor-container"));
        const threads: any[] = [];

        for (const root of roots) {
          const left = root.querySelector("div.user-info");
          const right = root.querySelector("div.reply");
          if (!left || !right) continue;

          const authorA = left.querySelector("a.name") as HTMLAnchorElement | null;
          const author = getText(authorA);
          const authorUrl = authorA ? hrefAbs(authorA) : "";

          const mainContentSpan = right.querySelector("div.reply-main div.reply-detail") as HTMLElement | null;
          const content = getText(mainContentSpan);

          const timeP = right.querySelector("div.reply-top") ||right.querySelector("div.reply-bottom") as HTMLElement | null;
          const timeRaw = getText(timeP);

          const commentId = root?.getAttribute("data-reply-id");

          const topImages = extractImages(right.querySelector("div.reply-detail"));

          const topvideos = extractVideos(right.querySelector("div.reply-detail"));

          // ✅ 关键修复：只抓第一层 replies 的 li，避免把嵌套 li 全抓进来
          const replyLis = Array.from(right.querySelectorAll("div.reply-comment>ul>li")) as HTMLElement[];

          const replies: any[] = [];
          const replySeen = new Set<string>(); // ✅ commentId 去重

          for (const li of replyLis) {
            
            const repliescommentId= li.getAttribute("data-comment-id");

            const dedupeKey =
              repliescommentId ? `rid:${repliescommentId}` : (li.outerHTML || "").slice(0, 180);
            if (replySeen.has(dedupeKey)) continue;
            replySeen.add(dedupeKey);

            const replyAuthorLink = li.querySelector("div.reply-sub-user a.name") as HTMLAnchorElement | null;
            const replyAuthor =
              getText(replyAuthorLink);
            const replyAuthorUrl = replyAuthorLink ? hrefAbs(replyAuthorLink) : "";

            const replyContentP = (li.querySelector("div.reply-sub-cont div.reply-sub-front") as HTMLElement | null) || li;

            const replyContent = getText(replyContentP);
            
            
            const replyTimeP = li.querySelector("div.reply-sub-handle span.handle-time");
            const replyTimeRaw = replyTimeP ? getText(replyTimeP) : "";

            if (replyAuthor && replyContent) {
              replies.push({
                repliescommentId: repliescommentId,
                author: replyAuthor,
                authorUrl: replyAuthorUrl,
                timeRaw: replyTimeRaw,
                content: replyContent,
                images: extractImages(li.querySelector("div.reply-sub-cont")), // ✅ 回复图通常在 li 内
                videos: extractVideos(li.querySelector("div.reply-sub-cont")),
              });
            }
          }

          //if (!author || !content) continue;

          threads.push({
            commentId,
            author,
            authorUrl,
            timeRaw,
            content,
            images: topImages,
            videos: topvideos,
            replies,
          });
        }

        return threads;
      }

      // ========= run =========
      
      
        //await clickAllExpands(5);
        await autoScroll({ maxLoops: 14, pauseMs: 200 });
        await clickAllExpands(5);
        await sleep(500)
        
        const comments = extractThreadedComments();
        
      
      

      const totalImgsOnPage = document.querySelectorAll("img").length;

      return comments;
      });

      comments.push(comment)
      index = index + 1
      await page.goto( url.trim().slice(0, -6) + String(index) + ".html")
      if (page.url() !== url.trim().slice(0, -6) + String(index) + ".html"){
        break
      }
    }
   


  const result = {
        url: url,
        extractedAt: new Date().toISOString(),
        lord,
        comments
      }

  results.push(result)
}
    //response.appendResponseLine("```json");
    response.appendResponseLine(JSON.stringify(results, null, 2));
    //response.appendResponseLine("```");
    
},

});