/**
 * 국비지원 교육과정 제안/입찰 공고 수집 스크립트
 *
 * 1) 직업능력심사평가원(KSQA) — 심사평가공고 + 공지사항
 * 2) 고용노동부(MOEL) — 공지사항 (키워드 필터)
 * 3) 나라장터(G2B) Open API — 용역 입찰공고 (키워드 필터, G2B_API_KEY 필수)
 * 4) 정보통신기획평가원(IITP) — 공지사항/보도자료/사업공고 (키워드 필터)
 *
 * 결과: data/bids.json (만료된 공고는 자동 정리)
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const KSQA_BASE = 'https://www.ksqa.or.kr';
const MOEL_BASE = 'https://www.moel.go.kr';
const G2B_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const IITP_BASE = 'https://www.iitp.kr';
const NIPA_BASE = 'https://www.nipa.kr';
const BIZ_BASE = 'https://www.bizinfo.go.kr';

// 만료 정책
const EXPIRY = {
  // 게시 N일 후 자동 만료 (최후 방어선)
  maxAgeDays: 365,
  // 상태가 '결과발표' / '접수마감' 인 경우 게시 N일 후 만료
  finishedAgeDays: 14,
};

// 훈련/교육 관련 키워드 (MOEL/G2B 필터링용)
const KEYWORDS = [
  // KDT/디지털 인재 핵심
  'K-Digital', 'K-디지털', 'KDT',
  '디지털 교육', '디지털교육', '디지털 인재', '디지털 핵심',
  'AI 인재', 'AI 캠퍼스', 'Pre AI',
  // 직업훈련 일반
  '직업훈련', '훈련과정', '교육과정',
  '인력양성', '양성훈련', '양성과정',
  '실무인재', '직업능력', '훈련생', '훈련기관',
  // 사업/공모
  '인재양성', '직무능력', '디지털전환', '디지털 전환',
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

async function tryFetch(url, opts = {}, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        timeout: 45000,
        ...opts,
        headers: { ...HEADERS, ...(opts.headers || {}) },
      });
      // 호출자에서 status 검증 (401/403 등 에러 본문 활용 위함)
      return res;
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await sleep(2000 * (i + 1));
    }
  }
  throw lastError;
}

async function tryFetchOk(url, opts) {
  const res = await tryFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
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
// 최근 N 페이지 수집 (페이지당 15행, 상위 5행은 고정 — nttId 기반 dedup으로 자동 중복 제거)
const KSQA_MAX_PAGES = 3;

async function fetchKsqaPages(pid, bbsId, categoryLabel) {
  const all = [];
  for (let page = 1; page <= KSQA_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      bbsId,
      nttId: '0',
      bbsTyCode: 'BBST03',
      bbsAttrbCode: 'BBSA03',
      authFlag: '',
      pageIndex: String(page),
      category_board: '',
      pid,
      bbsMode: 'list',
    });
    const url = `${KSQA_BASE}/index.do?${params}`;
    try {
      const res = await tryFetchOk(url);
      const html = await res.text();
      const items = parseKsqaPage(html, pid, categoryLabel);
      all.push(...items);
      await sleep(300);
    } catch (e) {
      // 한 페이지 실패해도 이전 페이지는 사용
      if (page === 1) throw e;
      console.error(`  KSQA ${categoryLabel} p${page} 실패: ${e.message} (이전 페이지까지 ${all.length}건 수집)`);
      break;
    }
  }
  return all;
}

async function fetchKsqaEval() {
  return fetchKsqaPages('HP010201', 'BBSMSTR_000000000031', '심사평가공고');
}

async function fetchKsqaNotice() {
  return fetchKsqaPages('HP010101', 'BBSMSTR_000000000021', '공지사항');
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

// ─── ③ 고용노동부 공지사항 (키워드 필터, 다중 페이지) ────────────────
const MOEL_MAX_PAGES = 5;

async function fetchMoelNotices() {
  const all = [];
  for (let page = 1; page <= MOEL_MAX_PAGES; page++) {
    const url = `${MOEL_BASE}/news/notice/noticeList.do?pageIndex=${page}`;
    let res;
    try {
      res = await tryFetchOk(url);
    } catch (e) {
      if (page === 1) throw e;
      console.error(`  MOEL p${page} 실패: ${e.message} (이전 페이지까지 ${all.length}건)`);
      break;
    }
    const html = await res.text();
    const tableMatch = html.match(
      /<table[^>]*class="[^"]*tstyle_list[^"]*"[\s\S]*?<\/table>/i
    );
    if (!tableMatch) break;
    const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const tds = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      if (tds.length < 5) continue;
      const cells = tds.map((td) => decode(strip(td)));
      const seq = cells[0];
      const titleCell = tds[1];
      const titleAttr = titleCell.match(/title="([^"]+)"/);
      const title = titleAttr
        ? decode(titleAttr[1])
        : cells[1].replace(/^\[[^\]]+\]\s*/, '');
      const dept = cells[2];
      const postedDate = parseKoDate(cells[4]);
      const href = extractHref(row);
      if (!title) continue;
      if (!matchesKeyword(title)) continue;

      all.push({
        id: `moel-${seq || href || `p${page}-${i}`}`,
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
    await sleep(300);
  }
  return all;
}

// ─── ④ IITP — 공지/보도자료/사업공고 (Vue API 직접 호출) ──────────────
const IITP_BOARDS = [
  { seq: 37, refPath: '/web/lay1/bbs/S1T12C37/A/7/list.do', category: '공지사항' },
  { seq: 38, refPath: '/web/lay1/bbs/S1T12C38/A/8/list.do', category: '보도자료' },
  { seq: 31, refPath: '/web/lay1/bbs/S1T11C31/A/4/list.do', category: '사업공고' },
];

async function fetchIitpBoard(board) {
  const refererUrl = `${IITP_BASE}${board.refPath}`;
  // 1) 페이지 fetch — CSRF 토큰 + 쿠키 획득
  const pageRes = await tryFetchOk(refererUrl);
  const html = await pageRes.text();
  const csrf = html.match(
    /<meta[^>]*name=["']_csrf["'][^>]*content=["']([^"']+)["']/
  )?.[1];
  const csrfHeader =
    html.match(/<meta[^>]*name=["']_csrf_header["'][^>]*content=["']([^"']+)["']/)?.[1] ||
    'X-CSRF-TOKEN';
  const cookies = pageRes.headers.raw()['set-cookie']
    ?.map((c) => c.split(';')[0])
    .join('; ');

  // 2) API 호출
  const apiUrl = `${IITP_BASE}/board-svc/api/bbs/A/list.do`;
  const res = await tryFetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: refererUrl,
      ...(csrf ? { [csrfHeader]: csrf } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify({
      cms_menu_seq: board.seq,
      cpage: 1,
      rows: 30,
      keyword: '',
      condition: '',
      sort: 'latest',
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.result !== 'SUCCESS') throw new Error(`API result: ${data.result}`);

  // notice_list (고정 상단) + list (일반) 통합
  const allItems = [...(data.notice_list || []), ...(data.list || [])];
  const items = [];
  for (const it of allItems) {
    const title = decode(it.title || '');
    if (!title || !matchesKeyword(title)) continue;
    const articleSeq = it.article_seq;
    const detailUrl = `${IITP_BASE}${board.refPath.replace('/list.do', '/view.do')}?article_seq=${articleSeq}`;
    items.push({
      id: `iitp-${board.seq}-${articleSeq}`,
      source: 'IITP',
      sourceLabel: '정보통신기획평가원',
      category: board.category,
      subCategory: it.reg_nm || null,
      title,
      postedDate: parseKoDate(it.reg_dt),
      deadline: null,
      status: null,
      url: detailUrl,
    });
  }
  return items;
}

async function fetchIitpAll() {
  const all = [];
  for (const b of IITP_BOARDS) {
    try {
      const items = await fetchIitpBoard(b);
      all.push(...items);
      await sleep(400);
    } catch (e) {
      console.error(`  IITP ${b.category} 실패: ${e.message}`);
    }
  }
  return all;
}

// ─── ⑤ NIPA — 공지사항/사업공고/입찰공고 ────────────────────────────────
const NIPA_BOARDS = [
  { path: '/home/2-1', category: '공지사항', maxPages: 2, schema: 'standard' },
  { path: '/home/2-2', category: '사업공고', maxPages: 3, schema: 'business' }, // D-day, 신청기간 포함
  { path: '/home/2-3', category: '입찰공고', maxPages: 2, schema: 'standard' },
];

// "신청기간 : YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM" → end date
function extractNipaDeadline(text) {
  const m = text.match(/신청기간[\s:]*\d{4}[-.]\d{1,2}[-.]\d{1,2}[^~]*~\s*(\d{4}[-.]\d{1,2}[-.]\d{1,2})/);
  return m ? parseKoDate(m[1]) : null;
}

async function fetchNipaBoard(board) {
  const all = [];
  for (let page = 1; page <= board.maxPages; page++) {
    const url = `${NIPA_BASE}${board.path}${page > 1 ? `?curPage=${page}` : ''}`;
    let html;
    try {
      const res = await tryFetchOk(url);
      html = await res.text();
    } catch (e) {
      if (page === 1) throw e;
      console.error(`  NIPA ${board.category} p${page} 실패: ${e.message} (이전 페이지까지 ${all.length}건)`);
      break;
    }
    const tableMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/i);
    if (!tableMatch) break;
    const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const tds = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      if (tds.length < 4) continue;
      const cells = tds.map((td) => decode(strip(td)));

      let title, postedDate, deadline = null, status = null, subCategory = null, href = null;

      if (board.schema === 'business') {
        // 5 cols: 번호, D-day, 제목셀, 작성자, 작성일
        const dDay = cells[1] || '';
        const titleCell = cells[2] || '';
        // [카테고리] --> 제목 ... 신청기간 : ...
        const catM = titleCell.match(/^\[([^\]]+)\]/);
        if (catM) subCategory = catM[1];
        // 제목: [카테고리] --> 다음부터 "신청기간" 직전까지
        let cleanTitle = titleCell
          .replace(/^\[[^\]]+\]\s*-+>?\s*/, '')
          .replace(/-+>\s*/g, '')
          .split('신청기간')[0]
          .trim();
        // 사업명 중복 제거 (예: "...공고 사업명" 형태) — 휴리스틱
        if (cleanTitle.length > 80) cleanTitle = cleanTitle.slice(0, 200);
        title = cleanTitle;
        deadline = extractNipaDeadline(titleCell);
        postedDate = parseKoDate(cells[4]);
        if (dDay === '종료' || dDay === '마감') status = '접수마감';
        else if (/^D-\d+/.test(dDay)) status = '신청접수';
        href = tds[2].match(/href="([^"]+)"/)?.[1];
      } else {
        // 6 cols: 번호, 제목, 작성자, 파일, 조회, 작성일
        title = (cells[1] || '').replace(/-+>\s*/g, '').trim();
        postedDate = parseKoDate(cells[5]);
        href = tds[1].match(/href="([^"]+)"/)?.[1];
      }

      if (!title) continue;
      if (!matchesKeyword(title)) continue;
      if (!href) continue;

      const url2 = href.startsWith('http')
        ? href
        : href.startsWith('/')
        ? `${NIPA_BASE}${href}`
        : `${NIPA_BASE}${board.path}/${href}`;
      const idM = url2.match(/(\d+)$/);
      const id = idM ? idM[1] : `${board.path}-p${page}-${i}`;
      all.push({
        id: `nipa-${id}`,
        source: 'NIPA',
        sourceLabel: '정보통신산업진흥원',
        category: board.category,
        subCategory,
        title,
        postedDate,
        deadline,
        status,
        url: url2,
      });
    }
    await sleep(400);
  }
  return all;
}

async function fetchNipaAll() {
  const all = [];
  for (const b of NIPA_BOARDS) {
    try {
      const items = await fetchNipaBoard(b);
      all.push(...items);
    } catch (e) {
      console.error(`  NIPA ${b.category} 실패: ${e.message}`);
    }
  }
  return all;
}

// ─── 기업마당 (bizinfo.go.kr) — 정부 통합 지원사업 공고 ─────────────────
// 8 cols: 번호, 지원분야, [지역]제목, 신청기간, 소관부처, 수행기관, 등록일, 조회수
const BIZ_MAX_PAGES = 3;

async function fetchBizinfo() {
  const all = [];
  for (let page = 1; page <= BIZ_MAX_PAGES; page++) {
    const url = `${BIZ_BASE}/sii/siia/selectSIIA200View.do?rows=15&cpage=${page}`;
    let html;
    try {
      const res = await tryFetchOk(url);
      html = await res.text();
    } catch (e) {
      if (page === 1) throw e;
      console.error(`  BIZ p${page} 실패: ${e.message} (이전 페이지까지 ${all.length}건)`);
      break;
    }
    const tableMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/i);
    if (!tableMatch) break;
    const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const tds = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
      if (tds.length < 7) continue;
      const cells = tds.map((td) => decode(strip(td)));
      const no = cells[0];
      const field = cells[1] || null; // 지원분야: 인력/기술/경영 등
      const titleRaw = cells[2] || '';
      const period = cells[3] || '';
      const ministry = cells[4] || null;
      const orgName = cells[5] || null;
      const postedDate = parseKoDate(cells[6]);

      // [지역] 추출
      const regionM = titleRaw.match(/^\[([^\]]+)\]\s*/);
      const region = regionM ? regionM[1] : null;
      const title = regionM ? titleRaw.replace(regionM[0], '').trim() : titleRaw;
      if (!title) continue;
      if (!matchesKeyword(title)) continue;

      // 마감일 추출: "YYYY-MM-DD ~ YYYY-MM-DD"
      let deadline = null;
      const periodM = period.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
      if (periodM) deadline = periodM[2];

      const href = tds[2].match(/href="([^"]+)"/)?.[1];
      const pblancM = href?.match(/pblancId=([^&]+)/);
      const pblancId = pblancM ? pblancM[1] : `p${page}-${i}`;
      const detailUrl = href
        ? (href.startsWith('http') ? href : `${BIZ_BASE}${href}`)
        : url;

      all.push({
        id: `biz-${pblancId}`,
        source: 'BIZ',
        sourceLabel: '기업마당',
        category: field || '지원사업',
        subCategory: [ministry, region].filter(Boolean).join(' · ') || null,
        title,
        postedDate,
        deadline,
        status: null,
        orgName,
        url: detailUrl,
      });
    }
    await sleep(400);
  }
  return all;
}

// ─── ⑤ 나라장터 Open API (용역 입찰공고, 키워드 필터) ──────────────────
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
  const res = await tryFetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} — ${text.slice(0, 200).replace(/\s+/g, ' ')}`
    );
  }
  if (text.trim().startsWith('<')) {
    throw new Error(
      `XML 에러 응답 — ${text.slice(0, 200).replace(/\s+/g, ' ')}`
    );
  }
  const data = JSON.parse(text);

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

// ─── 만료 판단 ────────────────────────────────────────────────────────
function isExpired(bid, todayStr, nowMs) {
  // 1) 명시 마감일이 지남
  if (bid.deadline && bid.deadline < todayStr) return true;
  // 2) 상태가 '결과발표' / '접수마감' 이고 게시 N일 이상 지남
  if (
    bid.postedDate &&
    (bid.status === '결과발표' || bid.status === '접수마감')
  ) {
    const postedMs = new Date(bid.postedDate).getTime();
    if ((nowMs - postedMs) / 86400000 > EXPIRY.finishedAgeDays) return true;
  }
  // 3) 매우 오래된 공고 (1년 이상)
  if (bid.postedDate) {
    const postedMs = new Date(bid.postedDate).getTime();
    if ((nowMs - postedMs) / 86400000 > EXPIRY.maxAgeDays) return true;
  }
  return false;
}

// ─── ⑥ 통합 ───────────────────────────────────────────────────────────
async function collectAll() {
  const apiKey = (process.env.G2B_API_KEY || '').trim();
  const outPath = path.join(__dirname, '..', 'data', 'bids.json');

  // 기존 데이터 로드 (소스별 실패 시 fallback 용)
  let existing = { bids: [] };
  try {
    if (fs.existsSync(outPath)) {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    }
  } catch {
    /* 무시 */
  }
  const existingBySource = (src) =>
    (existing.bids || []).filter((b) => b.source === src);

  // 소스별 결과: null = 시도 후 실패 (기존 데이터 유지), 배열 = 성공 (덮어쓰기)
  const results = { KSQA: null, MOEL: null, G2B: null, IITP: null, NIPA: null, BIZ: null };

  console.log('[bids] KSQA 심사평가공고 + 공지사항 수집...');
  try {
    const ev = await fetchKsqaEval();
    const no = await fetchKsqaNotice();
    results.KSQA = [...ev, ...no];
    console.log(`  KSQA ${results.KSQA.length}건 (심사평가 ${ev.length} + 공지 ${no.length})`);
  } catch (e) {
    console.error(`  KSQA 실패: ${e.message}`);
  }

  console.log('[bids] 고용노동부 공지사항 수집 (키워드 필터)...');
  try {
    results.MOEL = await fetchMoelNotices();
    console.log(`  MOEL ${results.MOEL.length}건 (필터 후)`);
  } catch (e) {
    console.error(`  MOEL 실패: ${e.message}`);
  }

  console.log('[bids] IITP 공지/보도자료/사업공고 수집 (키워드 필터)...');
  try {
    results.IITP = await fetchIitpAll();
    console.log(`  IITP ${results.IITP.length}건 (필터 후)`);
  } catch (e) {
    console.error(`  IITP 실패: ${e.message}`);
  }

  console.log('[bids] NIPA 공지/사업공고/입찰 수집 (키워드 필터)...');
  try {
    results.NIPA = await fetchNipaAll();
    console.log(`  NIPA ${results.NIPA.length}건 (필터 후)`);
  } catch (e) {
    console.error(`  NIPA 실패: ${e.message}`);
  }

  console.log('[bids] 기업마당 정부 통합 지원사업 수집 (키워드 필터)...');
  try {
    results.BIZ = await fetchBizinfo();
    console.log(`  BIZ ${results.BIZ.length}건 (필터 후)`);
  } catch (e) {
    console.error(`  BIZ 실패: ${e.message}`);
  }

  if (apiKey) {
    console.log('[bids] 나라장터 Open API 수집 (키워드 필터)...');
    try {
      results.G2B = await fetchG2bBids(apiKey);
      console.log(`  G2B ${results.G2B.length}건 (필터 후)`);
    } catch (e) {
      console.error(`  G2B 실패: ${e.message}`);
    }
  } else {
    console.log('[bids] G2B_API_KEY 미설정 — 나라장터 스킵');
    results.G2B = []; // 키 없으면 명시적 비움 (덮어쓰기 OK)
  }

  // 각 소스 병합: 성공이면 새 데이터, 실패면 기존 유지
  const merged = [];
  for (const src of ['KSQA', 'MOEL', 'IITP', 'NIPA', 'BIZ', 'G2B']) {
    if (results[src] !== null) {
      merged.push(...results[src]);
    } else {
      const keep = existingBySource(src);
      if (keep.length) {
        console.log(`  [keep] ${src}: 기존 ${keep.length}건 유지 (이번 수집 실패)`);
        merged.push(...keep);
      }
    }
  }

  // 만료된 공고 자동 정리
  const todayStr = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  const beforeExpiry = merged.length;
  const active = merged.filter((b) => !isExpired(b, todayStr, nowMs));
  const expiredCount = beforeExpiry - active.length;
  if (expiredCount > 0) {
    console.log(`  [expire] ${expiredCount}건 정리 (마감일 경과/오래된 공고)`);
  }

  // 중복 제거 (동일 url 또는 동일 id)
  const seen = new Set();
  const deduped = active.filter((b) => {
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
        iitp: bids.filter((b) => b.source === 'IITP').length,
        nipa: bids.filter((b) => b.source === 'NIPA').length,
        biz: bids.filter((b) => b.source === 'BIZ').length,
        g2b: bids.filter((b) => b.source === 'G2B').length,
      },
      keywords: KEYWORDS,
      updatedAt: new Date().toISOString(),
      count: bids.length,
    };

    const outPath = path.join(__dirname, '..', 'data', 'bids.json');

    // 본문(updatedAt 제외)이 동일하면 파일 재작성 생략 — git commit 누적 방지
    const cmpKey = (p) => {
      const c = { ...p };
      delete c.updatedAt;
      return JSON.stringify(c);
    };
    let changed = true;
    if (fs.existsSync(outPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        if (cmpKey(existing) === cmpKey(payload)) changed = false;
      } catch {
        /* 파싱 실패는 변경된 것으로 간주 */
      }
    }
    if (changed) {
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(
        `\n[done] ${bids.length}건 (KSQA ${payload.sources.ksqa} / MOEL ${payload.sources.moel} / IITP ${payload.sources.iitp} / NIPA ${payload.sources.nipa} / BIZ ${payload.sources.biz} / G2B ${payload.sources.g2b}) → 갱신`
      );
    } else {
      console.log(`\n[done] ${bids.length}건 — 변경사항 없음, 파일 유지`);
    }
  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }
}

main();
