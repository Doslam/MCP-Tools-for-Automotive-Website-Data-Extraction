const dcd_extract = async () => {
  // ========= utils =========
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const norm = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();

  const getText = (el?: Element | null) =>
    norm((el as HTMLElement | null)?.textContent || (el as HTMLElement | null)?.innerText || "");

  const hrefAbs = (a?: Element | null) => {
    if (!a) return "";
    const href = (a as HTMLAnchorElement).getAttribute("href");
    if (!href) return "";
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return href;
    }
  };

  // ========= extract images =========
  function extractImages(container?: Element | null): string[] {
    if (!container) return [];

    const toAbs = (u: string) => {
      if (!u) return "";
      try { return new URL(u, location.origin).toString(); }
      catch { return u; }
    };

    const imgs = Array.from(container.querySelectorAll("img"))
      .map(img =>
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("data-lazy-src") ||
        (img as HTMLImageElement).currentSrc ||
        ""
      )
      .map(toAbs)
      .filter(Boolean);

    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of imgs) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out;
  }

  // ========= expand =========
  function findExpandButtons(): HTMLButtonElement[] {
    const btns = document.querySelectorAll("button.tw-text-common-blue");
    const out: HTMLButtonElement[] = [];

    for (const b of Array.from(btns)) {
      const t = getText(b);
      if (!t) continue;
      if (t.includes("收起")) continue;
      if (t.includes("条回复") || t.includes("全部") || t.includes("展开") || t.includes("更多")) {
        out.push(b as HTMLButtonElement);
      }
    }
    return out;
  }

  async function clickAllExpands(rounds = 6, perRoundLimit = 25) {
    for (let i = 0; i < rounds; i++) {
      const btns = findExpandButtons();
      if (!btns.length) break;

      let clicked = 0;
      const seen = new Set<string>();

      for (const b of btns) {
        if (clicked >= perRoundLimit) break;
        const key = (b as HTMLElement).dataset?.logView || (b.outerHTML || "").slice(0, 120);
        if (seen.has(key)) continue;
        seen.add(key);

        try { b.click(); clicked++; }
        catch {
          try {
            b.scrollIntoView({ block: "center" });
            b.click();
            clicked++;
          } catch {}
        }
        await sleep(30);
      }

      if (!clicked) break;
      await sleep(120);
    }
  }

  async function autoScrollSmart(
    { maxRounds = 60, pauseMs = 350 }: { maxRounds?: number; pauseMs?: number } = {}
  ) {
    let lastH = 0;
    let stable = 0;

    for (let i = 0; i < maxRounds; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(pauseMs);

      if (i % 3 === 2) {
        await clickAllExpands(1, 30);
      }

      const h = document.documentElement.scrollHeight;
      stable = h === lastH ? stable + 1 : 0;
      lastH = h;
      if (stable >= 2) break;
    }
  }

  // ========= post =========
  function extractPost() {
    const authorA = document.querySelector('p.tw-truncate a[href^="/user/"]');
    const timeP = document.querySelector("div.user p");
    const contentSpan = document.querySelector("div.content p.article-content span");
    const contentDiv = document.querySelector("div.content");

    const timeRaw = getText(timeP);
    let date = "";
    let publishedTo = "";

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
      authorUrl: hrefAbs(authorA),
      timeRaw,
      date,
      publishedTo,
      content: getText(contentSpan) || getText(contentDiv),
      images: extractImages(postRoot),
    };
  }

  // ========= id parser =========
  function parseDataLogView(card?: Element | null) {
    let groupId = "";
    let commentId = "";
    const dlv = card?.getAttribute("data-log-view");
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
  function findThreadRoots(): HTMLElement[] {
    const cards = Array.from(document.querySelectorAll("section.community-card[data-log-view]"));
    const out: HTMLElement[] = [];
    const seen = new Set<string>();

    for (const mainCard of cards) {
      const right = mainCard.closest("div.tw-flex-1");
      const root = right?.closest("div.tw-flex");
      const left = root?.querySelector(":scope > div.tw-w-232");
      if (!root || !left || !right) continue;

      const hasReplyList = !!right.querySelector("ul > li");
      const hasCommentMeta = !!right.querySelector("span.tw-text-video-shallow-gray");
      if (!hasReplyList && !hasCommentMeta) continue;

      const { commentId } = parseDataLogView(mainCard);
      const key = commentId ? `cid:${commentId}` : (root.outerHTML || "").slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push(root as HTMLElement);
    }
    return out;
  }

  // ========= extract threads + replies =========
  function extractThreadedComments() {
    const roots = findThreadRoots();
    const threads: any[] = [];

    for (const root of roots) {
      const left = root.querySelector(":scope > div.tw-w-232");
      const right = root.querySelector(":scope > div.tw-flex-1");
      if (!left || !right) continue;

      const authorA = left.querySelector("p.tw-truncate a[href^='/user/']");
      const author = getText(authorA);
      const authorUrl = hrefAbs(authorA);

      const isOP = Array.from(left.querySelectorAll("span"))
        .some(sp => getText(sp).includes("楼主"));

      const mainCard = right.querySelector("section.community-card[data-log-view]");
      const mainContentSpan = mainCard?.querySelector("span.tw-text-common-black");
      const content = getText(mainContentSpan);

      let timeRaw = "";
      for (const sp of Array.from(right.querySelectorAll("span.tw-text-video-shallow-gray"))) {
        const t = getText(sp);
        if (t.includes("评论发表于")) { timeRaw = t; break; }
      }

      const { groupId, commentId } = parseDataLogView(mainCard);
      const topImages = extractImages(right);

      const replies: any[] = [];
      const replyLis = Array.from(right.querySelectorAll(":scope ul > li"));

      for (const li of replyLis) {
        const replyOuter = li.querySelector("section.community-card[data-log-view]");
        if (!replyOuter) continue;

        const { commentId: replyCommentId } = parseDataLogView(replyOuter);

        const replyAuthorLink = replyOuter.querySelector("a[href^='/user/']");
        const replyAuthor =
          getText(replyOuter.querySelector("a[href^='/user/'] span.tw-text-black")) ||
          getText(replyAuthorLink);

        const replyAuthorUrl = hrefAbs(replyAuthorLink);
        const inner = li.querySelector("section.tw-pl-56") || li;

        let replyContent = getText(inner.querySelector("span.tw-text-common-black"));
        if (!replyContent) {
          const spans = Array.from(inner.querySelectorAll("span.tw-text-common-black"))
            .filter(sp => !sp.closest("div.jsx-1055894087"));
          replyContent = getText(spans[0]);
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
            images: extractImages(li),
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
        replies,
      });
    }

    return threads;
  }

  // ========= run =========
  await autoScrollSmart({ maxRounds: 25, pauseMs: 250 });
  await clickAllExpands(8, 40);

  const post = extractPost();
  const comments = extractThreadedComments();

  return {
    url: location.href,
    extractedAt: new Date().toISOString(),
    post,
    comments,
    debug: {
      totalImgsOnPage: document.querySelectorAll("img").length,
      postImages: post.images.length,
      threadWithImages: comments.filter((t: any) => (t.images?.length || 0) > 0).length,
    }
  };
}


export default dcd_extract;