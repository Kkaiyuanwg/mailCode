(function () {
  const FEED_URL = 'https://mail.google.com/mail/u/';
  const MAX_ACCOUNT_SLOTS = 6;
  const CODE_PATTERN = /(?:c[oó]digo|code|security|verification|confirmation|confirm(?:ation)?|otp|one[- ]time|pin)[^\d]{0,48}(\d{4,8})\b/gi;

  function decodeEntities(value) {
    return value
      .replace(/&#(\d+);/g, (entity, number) => {
        const codePoint = Number(number);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      })
      .replace(/&#x([0-9a-f]+);/gi, (entity, number) => {
        const codePoint = parseInt(number, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      })
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => ({
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' '
      })[name.toLowerCase()] || entity);
  }

  function getTagText(xml, name) {
    const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));
    if (!match) return '';
    return decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getCode(text) {
    for (const match of text.matchAll(CODE_PATTERN)) {
      const code = match[1];
      if (code.length === 4 && /^(19|20)/.test(code)) continue;
      return code;
    }
    return null;
  }

  function parseFeed(xml, afterMs) {
    if (!/<feed\b/i.test(xml)) {
      throw new Error('Gmail did not return its mail feed. Sign in to Gmail and try again.');
    }

    const feedTitle = getTagText(xml, 'title');
    const email = feedTitle.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
    const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
    let latest = null;

    for (const [, entry] of entries) {
      const subject = getTagText(entry, 'title') || 'Confirmation email';
      const summary = getTagText(entry, 'summary');
      const code = getCode(`${subject}\n${summary}`);
      if (!code) continue;

      const internalDate = Date.parse(getTagText(entry, 'modified') || getTagText(entry, 'issued')) || 0;
      if (typeof afterMs === 'number' && internalDate < afterMs) continue;
      if (latest && internalDate <= latest.internalDate) continue;

      const authorName = getTagText(entry, 'name');
      const authorEmail = getTagText(entry, 'email');
      latest = {
        code,
        subject,
        from: authorEmail ? `${authorName ? `${authorName} ` : ''}<${authorEmail}>` : authorName || 'Unknown sender',
        internalDate
      };
    }

    return { email, result: latest };
  }

  async function fetchFeed(slot = '0', afterMs) {
    const response = await fetch(`${FEED_URL}${encodeURIComponent(slot)}/feed/atom?t=${Date.now()}`, {
      credentials: 'include',
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`Could not read the Gmail feed (${response.status}). Sign in to Gmail and try again.`);
    }

    const responseSlot = response.url.match(/\/mail\/u\/(\d+)(?:[/?#]|$)/)?.[1];
    if (responseSlot !== String(slot)) {
      const error = new Error('Gmail session not found for this account.');
      error.name = 'AccountSlotUnavailableError';
      throw error;
    }

    const feed = parseFeed(await response.text(), afterMs);
    return { ...feed, slot: String(slot) };
  }

  async function listAccounts() {
    const checks = await Promise.all(
      Array.from({ length: MAX_ACCOUNT_SLOTS }, async (_, index) => {
        try {
          const feed = await fetchFeed(String(index));
          return feed.email ? { slot: feed.slot, email: feed.email } : null;
        } catch (error) {
          if (error.name === 'AccountSlotUnavailableError') return null;
          throw error;
        }
      })
    );
    return checks.filter(Boolean);
  }

  globalThis.ConfirmCodeGmail = { fetchFeed, listAccounts };
})();
