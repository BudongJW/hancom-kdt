/**
 * 국비지원 교육과정 제안/입찰 공고 수집 스크립트
 *
 * 1) 직업능력심사평가원(KSQA) — 심사평가공고 + 공지사항
 * 2) 고용노동부(MOEL) — 공지사항 (키워드 필터)
 * 3) 나라장터(G2B) Open API — 용역 입찰공고 (키워드 필터, G2B_API_KEY 필수)
 *
 * 결과: data/bids.json
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const KSQA_BASE = 'https://www.ksqa.or.kr';
const MOEL_BASE = 'https://www.moel.go.kr';
const G2B_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';

// 훈련/교육 관련 키워드 (MOEL/G2B 필터링용)
const KEYWORDS = [
  'K-Digital', 'KDT', '디지털 교육', '디지털교육',
  '직업훈련', '훈련과정', '교육과정', '인력양성', '양성과정',
  '직업능력', '훈련생', '훈련기관',
];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  Connection: 'keep-alive',
};

// ─── 유틸 ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) =>
  String(s || '')
    .replace(/<!--[\s\S]*?-->/g, ' ') // HTML 주석 제거
    .replace(/<[^>]*>/g, ' ') // 태그 제거
    .replace(/-->|<!--/g, ' ') // 주석 잔여 제거
    .replace(/\s+/g, ' ')
    .trim();
const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

// "YYYY.MM.DD" / "YYYY-MM-DD" / "YYYY.MM.DD (요일) HH:MM" → ISO 날짜 (YYYY-MM-DD)
function parseKoDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// "YYYY.MM.DD (요일) HH:MM ~ YYYY.MM.DD (요일) HH:MM" → { start, end }
function parseDateRange(s) {
  if (!s) return { start: null, end: null };
  const parts = String(s).split('~').map((p) => p.trim());
  return {
    start: parseKoDate(parts[0]),
    end: parts[1] ? parseKoDate(parts[1]) : null,
  };
}

function matchesKeyword(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return KEYWORDS.some((kw) => t.includes(kw.toLowerCase()));
}

async function tryFetch(url, opts = {}, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        timeout: 20000,
        ...opts,
        headers: { ...HEADERS, ...(opts.headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// 행(<tr>) → 셀(<td>) 배열로 분해
function rowsToCells(html, tableClass) {
  const tableRe = new RegExp(
    `<table[^>]*class="[^"]*${tableClass}[^"]*"[\\s\\S]*?<\\/table>`,
    'i'
  );
  const tableMatch = html.match(tableRe);
  if (!tableMatch) return [];
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  return rows.map((r) => {
    const tds = r.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
    return tds.map((td) => decode(strip(td)));
  });
}

// 첫 a[href] 추출
function extractHref(rowHtml) {
  const m = rowHtml.match(/<a[^>]*href="([^"]+)"/i);
  return m ? decode(m[1]) : null;
}

// ─── ① KSQA 심사평가공고 (가장 핵심: 교육과정 제안 공고 다수) ──────────
async function fetchKsqaEval() {
  const url = `${KSQA_BASE}/?pid=HP010201`;
  const res = await tryFetch(url);
  const html = await res.text();
  return parseKsqaPage(html, 'HP010201', '심사평가공고');
}

// ─── ② KSQA 공지사항 ─────────────────────────────────────────────────
async function fetchKsqaNotice() {
  const url = `${KSQA_BASE}/?pid=HP010101`;
  const res = await tryFetch(url);
  const html = await res.text();
  return parseKsqaPage(html, 'HP010101', '공지사항');
}

function parseKsqaPage(html, pid, categoryLabel) {
  const tableMatch = html.match(
    /<table[^>]*class="[^"]*table_list[^"]*"[\s\S]*?<\/table>/i
  );
  if (!tableMatch) return [];
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    // 헤더 제외
    const row = rows[i];
    const tds = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
    if (tds.length < 5) continue;
    const cells = tds.map((td) => decode(strip(td)));
    const href = extractHref(row);
    if (!href) continue;
    const nttIdM = href.match(/nttId=(\d+)/);
    const nttId = nttIdM ? nttIdM[1] : null;

    const isEval = pid === 'HP010201';
    // eval: [번호, 센터, 제목, 정기/심사/상시, 일자(범위), 상태, 조회]
    // notice: [번호, 센터, 제목, 조회, 일자]
    const center = cells[1] || null;
    // 신규 게시글 표시(N) 제거
    const title = (cells[2] || '').replace(/\s+N\s*$/, '').trim();
    if (!title) continue;
    const isNew = /\s+N\s*$/.test(cells[2] || '');

    let postedDate = null,
      deadline = null,
      status = null,
      type = null;
    if (isEval) {
      type = cells[3] || null;
      const dr = parseDateRange(cells[4]);
      postedDate = dr.start;
      deadline = dr.end;
      status = cells[5] || null;
    } else {
      postedDate = parseKoDate(cells[4]);
    }

    items.push({
      id: `ksqa-${pid}-${nttId || i}`,
      source: 'KSQA',
      sourceLabel: '직업능력심사평가원',
      category: categoryLabel,
      subCategory: center,
      type,
      title,
      postedDate,
      deadline,
      status,
      isNew,
      url: href.startsWith('http') ? href : `${KSQA_BASE}${href}`,
    });
  }
  return items;
}

// ─── ③ 고용노동부 공지사항 (키워드 필터) ──────────────────────────────
async function fetchMoelNotices() {
  const url = `${MOEL_BASE}/news/notice/noticeList.do`;
  const res = await tryFetch(url);
  const html = await res.text();
  const tableMatch = html.match(
    /<table[^>]*class="[^"]*tstyle_list[^"]*"[\s\S]*?<\/table>/i
  );
  if (!tableMatch) return [];
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const tds = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
    if (tds.length < 5) continue;
    const cells = tds.map((td) => decode(strip(td)));
    const seq = cells[0];
    const titleCell = tds[1];
    const titleAttr = titleCell.match(/title="([^"]+)"/);
    const title = titleAttr ? decode(titleAttr[1]) : cells[1].replace(/^\[[^\]]+\]\s*/, '');
    const dept = cells[2];
    const postedDate = parseKoDate(cells[4]);
    const href = extractHref(row);
    if (!title) continue;
    if (!matchesKeyword(title)) continue;

    items.push({
      id: `moel-${seq || href || i}`,
      source: 'MOEL',
      sourceLabel: '고용노동부',
      category: '공지사항',
      subCategory: dept || null,
      title,
      postedDate,
      deadline: null,
      status: null,
      url: href
        ? href.startsWith('http')
          ? href
          : `${MOEL_BASE}${href.startsWith('/') ? '' : '/news/notice/'}${href}`
        : url,
    });
  }
  return items;
}

// ─── ④ 나라장터 Open API (용역 입찰공고, 키워드 필터) ──────────────────
async function fetchG2bBids(apiKey) {
  // 최근 30일 등록건 조회
  const now = new Date();
  const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fmt = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
    `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

  const params = new URLSearchParams({
    serviceKey: apiKey,
    pageNo: '1',
    numOfRows: '100',
    inqryDiv: '1', // 1: 등록일시
    inqryBgnDt: fmt(past),
    inqryEndDt: fmt(now),
    type: 'json',
  });

  // 용역 입찰공고
  const url = `${G2B_BASE}/getBidPblancListInfoServc?${params}`;
  let data;
  try {
    const res = await tryFetch(url);
    const text = await res.text();
    // API 키 미승인/오류 시 XML 에러 응답이 올 수 있음
    if (text.trim().startsWith('<')) {
      throw new Error(`G2B XML 에러 응답: ${text.slice(0, 200)}`);
    }
    data = JSON.parse(text);
  } catch (e) {
    console.error(`[g2b] 호출 실패: ${e.message}`);
    return [];
  }

  const items = data?.response?.body?.items || [];
  const list = Array.isArray(items) ? items : items.item ? [].concat(items.item) : [];
  const result = [];
  for (const it of list) {
    const title = it.bidNtceNm || '';
    if (!matchesKeyword(title)) continue;
    result.push({
      id: `g2b-${it.bidNtceNo}-${it.bidNtceOrd || '00'}`,
      source: 'G2B',
      sourceLabel: '나라장터',
      category: '용역 입찰공고',
      subCategory: it.dminsttNm || null,
      title,
      postedDate: parseKoDate(it.bidNtceDt),
      deadline: parseKoDate(it.bidClseDt),
      status: null,
      orgName: it.dminsttNm || null,
      estimatedPrice: it.presmptPrce ? Number(it.presmptPrce) : null,
      url: it.bidNtceDtlUrl || it.bidNtceUrl || null,
    });
  }
  return result;
}

// ─── ⑤ 통합 ───────────────────────────────────────────────────────────
async function collectAll() {
  const apiKey = process.env.G2B_API_KEY;
  const sources = [];

  console.log('[bids] KSQA 심사평가공고 수집...');
  try {
    const a = await fetchKsqaEval();
    console.log(`  ${a.length}건`);
    sources.push(...a);
  } catch (e) {
    console.error(`  실패: ${e.message}`);
  }

  console.log('[bids] KSQA 공지사항 수집...');
  try {
    const a = await fetchKsqaNotice();
    console.log(`  ${a.length}건`);
    sources.push(...a);
  } catch (e) {
    console.error(`  실패: ${e.message}`);
  }

  console.log('[bids] 고용노동부 공지사항 수집 (키워드 필터)...');
  try {
    const a = await fetchMoelNotices();
    console.log(`  ${a.length}건 (필터 후)`);
    sources.push(...a);
  } catch (e) {
    console.error(`  실패: ${e.message}`);
  }

  if (apiKey) {
    console.log('[bids] 나라장터 Open API 수집 (키워드 필터)...');
    try {
      const a = await fetchG2bBids(apiKey);
      console.log(`  ${a.length}건 (필터 후)`);
      sources.push(...a);
    } catch (e) {
      console.error(`  실패: ${e.message}`);
    }
  } else {
    console.log('[bids] G2B_API_KEY 미설정 — 나라장터 스킵');
  }

  // 중복 제거 (동일 url 또는 동일 id)
  const seen = new Set();
  const deduped = sources.filter((b) => {
    const key = b.url || b.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 최신순 정렬 (postedDate desc, id desc)
  deduped.sort((a, b) => {
    const da = a.postedDate || '0000-00-00';
    const db = b.postedDate || '0000-00-00';
    if (da !== db) return db.localeCompare(da);
    return String(b.id).localeCompare(String(a.id));
  });

  return deduped;
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  try {
    const bids = await collectAll();

    const payload = {
      source: 'multi',
      bids,
      sources: {
        ksqa: bids.filter((b) => b.source === 'KSQA').length,
        moel: bids.filter((b) => b.source === 'MOEL').length,
        g2b: bids.filter((b) => b.source === 'G2B').length,
      },
      keywords: KEYWORDS,
      updatedAt: new Date().toISOString(),
      count: bids.length,
    };

    const outPath = path.join(__dirname, '..', 'data', 'bids.json');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(
      `\n[done] ${bids.length}건 (KSQA ${payload.sources.ksqa} / MOEL ${payload.sources.moel} / G2B ${payload.sources.g2b}) → ${outPath}`
    );
  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }
}

main();
