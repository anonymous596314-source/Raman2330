// Chart instances (to destroy before re-rendering)
const charts = {};

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    setupSidebar();
    setupRefreshLogic();
    runApiDiagnostics(); // 背景執行，不阻塞頁面載入，F12 Console 可看結果
    await refreshData();
}

function setupSidebar() {
    const navItems = document.querySelectorAll('.nav-item');
    const panels = document.querySelectorAll('.panel');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(nav => nav.classList.remove('active'));
            panels.forEach(panel => panel.classList.remove('active'));
            item.classList.add('active');
            const targetPanel = document.getElementById(`panel-${item.dataset.panel}`);
            if (targetPanel) targetPanel.classList.add('active');
        });
    });
}

function setupRefreshLogic() {
    const refreshBtn = document.getElementById('refresh-btn');
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('loading');
        await refreshData();
        refreshBtn.classList.remove('loading');
    });
    setInterval(async () => { await refreshData(true); }, 60000);
}

async function refreshData(partial = false) {
    updateTimestamp();

    // ── 第一波：Quote + News 並行（畫面最快有資料）──────────────
    const [quote, news] = await Promise.allSettled([
        fetchQuoteSummary(),
        fetchNews()
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    if (quote) {
        document.getElementById('current-price').innerText = quote.price.toFixed(2);
        const changeEl = document.getElementById('price-change');
        const sign = quote.change >= 0 ? '+' : '';
        changeEl.innerText = `${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`;
        changeEl.className = 'price-change ' + (quote.change >= 0 ? 'up' : 'down');
    }

    if (news && news.length > 0) {
        const newsContainer = document.getElementById('news-container');
        newsContainer.innerHTML = '<h4>即時外資報告與新聞</h4>' + news.map(n => `
            <div class="news-item">
                <a href="${n.link}" target="_blank" rel="noopener noreferrer"><h5>${escapeHtml(n.title)}</h5></a>
                <p>${escapeHtml(n.publisher)} - ${new Date(n.providerPublishTime * 1000).toLocaleString('zh-TW')}</p>
            </div>
        `).join('');
        analyzeSentiment(news);
    } else {
        const newsContainer = document.getElementById('news-container');
        if (newsContainer) {
            newsContainer.innerHTML = '<h4>即時外資報告與新聞</h4><div class="chart-fallback" style="margin-top:12px;"><strong>新聞資料暫時無法取得</strong><span>Yahoo Finance proxy 未回應，請按右上角「更新資料」重試。情緒分析將在新聞載入後自動更新。</span></div>';
        }
    }

    if (partial) return;

    // ── 第二波：所有重資料全部並行發出 ──────────────────────────
    const [fund, techData, chipData, flowData, twdData, tsm1yData, soxData, adrData] =
        await Promise.allSettled([
            fetchFundamentals(),                          // 基本面
            fetchHistoricalData("6mo", "1d"),             // 技術面 K 線
            fetchHistoricalData("10y", "1wk"),            // 籌碼成本（需10年才有260週MA）
            fetchChipFlow(),                              // 三大法人
            fetchHistoricalData("1y",  "1wk", "TWD=X"),  // 匯率
            fetchHistoricalData("1y",  "1wk"),            // 台積 1y 週線
            fetchHistoricalData("1y",  "1wk", SOX_SYMBOL),
            fetchHistoricalData("1y",  "1wk", ADR_SYMBOL)
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    // 3. 基本面
    if (fund) {
        document.getElementById('pe-ratio').innerText = fund.peRatio ? (typeof fund.peRatio === 'number' ? fund.peRatio.toFixed(2) : fund.peRatio) : '--';
        document.getElementById('eps-ttm').innerText = fund.eps ? fund.eps.toFixed(2) : '--';
        const roeEl = document.getElementById('roe-value');
        if (roeEl) roeEl.innerText = fund.roe || '--';
        const divEl = document.getElementById('dividend-yield');
        if (divEl) divEl.innerText = fund.dividendYield || '--';
        if (fund.foreignRatio && fund.foreignRatio !== '--') {
            document.getElementById('foreign-ratio').innerText = fund.foreignRatio + '%';
        }
        renderFundamentalChart();
        renderEpsChart();
        renderYoyChart();
        renderMarginStackChart();
        renderCashflowCapexChart();
    }

    // 4. 技術面
    if (techData && techData.length > 0) {
        renderTechnicalChart(techData);
        renderVolumeChart(techData);
        renderRsiChart(techData);
        renderMacdChart(techData);
    } else {
        ['technical-chart', 'kd-chart', 'volume-chart', 'rsi-chart', 'macd-chart'].forEach(showChartFallback);
    }

    // 5. 籌碼面
    if (chipData && chipData.length > 0) {
        renderChipCostChart(chipData);
    } else {
        showChartFallback('chip-cost-chart');
    }
    if (flowData) {
        renderChipFlowChart(flowData);
        renderChipCumulativeChart(flowData);
        const sumForeign = flowData.foreign.reduce((a, b) => a + b, 0);
        const sumTrust = flowData.trust.reduce((a, b) => a + b, 0);
        const sumDealer = flowData.dealer.reduce((a, b) => a + b, 0);
        const fmt = (v) => {
            const el_sign = v >= 0 ? '+' : '';
            return `${el_sign}${Math.round(v).toLocaleString()}`;
        };
        const fEl = document.getElementById('foreign-net-30d');
        const tEl = document.getElementById('trust-net-30d');
        const dEl = document.getElementById('dealer-net-30d');
        if (fEl) { fEl.innerText = fmt(sumForeign); fEl.style.color = sumForeign >= 0 ? '#ef4444' : '#22c55e'; }
        if (tEl) { tEl.innerText = fmt(sumTrust); tEl.style.color = sumTrust >= 0 ? '#ef4444' : '#22c55e'; }
        if (dEl) { dEl.innerText = fmt(sumDealer); dEl.style.color = sumDealer >= 0 ? '#ef4444' : '#22c55e'; }
    } else {
        renderChipFlowChart();
        renderChipCumulativeChart();
    }

    // 6. 總經面
    if (twdData && twdData.length > 0 && tsm1yData && tsm1yData.length > 0) {
        renderMacroChart(tsm1yData, twdData);
    } else {
        showChartFallback('macro-chart');
    }
    if (soxData && soxData.length > 0 && adrData && adrData.length > 0) {
        renderSoxAdrChart(tsm1yData, soxData, adrData);
    } else {
        showChartFallback('sox-adr-chart');
    }
    updateMacroSnapshot(tsm1yData || [], twdData || [], soxData || [], adrData || []);

    // 7. 靜態圖表
    renderIndustryChart();
    renderOutlookChart();
    renderRiskChart();
}

function updateTimestamp() {
    document.getElementById('last-update-time').innerText = new Date().toLocaleString('zh-TW');
}

// ─── Chart Defaults ────────────────────────────────────────────
if (typeof window.Chart !== 'undefined') {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = 'Inter';
}

function createChart(ctxId, config) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return;
    if (typeof window.Chart === 'undefined') {
        const fallback = document.createElement('div');
        fallback.className = 'chart-fallback';
        fallback.innerHTML = '<strong>圖表套件未載入</strong><span>請確認網路可連到 Chart.js CDN 後重新整理。</span>';
        ctx.replaceWith(fallback);
        return;
    }
    if (charts[ctxId]) charts[ctxId].destroy();
    charts[ctxId] = new Chart(ctx, config);
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
}

/**
 * 當 API 資料抓不到時，在 canvas 位置顯示友善提示
 */
function showChartFallback(ctxId, msg) {
    const el = document.getElementById(ctxId);
    if (!el) return;
    // 若已被替換成 div，不重複替換
    if (el.tagName !== 'CANVAS') return;
    const fb = document.createElement('div');
    fb.className = 'chart-fallback';
    fb.innerHTML = `<strong>資料暫時無法取得</strong><span>${msg || 'Yahoo Finance / FinMind proxy 未回應，請按右上角「更新資料」重試，或稍後再試。'}</span>`;
    el.replaceWith(fb);
}

// ─── 基本面圖表 ────────────────────────────────────────────────
const QUARTER_LABELS = ['24Q1','24Q2','24Q3','24Q4','25Q1','25Q2','25Q3','25Q4','26Q1'];
const REVENUES_B     = [592.64, 673.51, 759.69, 868.46, 839.25, 933.79, 989.92, 1046.09, 1134.10];
const GROSS_MARGINS  = [53.1, 53.2, 57.8, 59.0, 58.8, 58.6, 59.5, 62.3, 66.3];
const EPS_QUARTERLY  = [7.98, 9.56, 12.55, 14.45, 13.95, 15.36, 17.44, 19.51, 22.08];
const OPERATING_MARGINS = [42.0, 42.5, 47.5, 49.0, 48.5, 49.6, 50.6, 54.0, 58.1];
const NET_MARGINS = [38.0, 36.8, 42.8, 43.1, 43.1, 44.3, 45.7, 48.4, 50.5];
const ANNUAL_LABELS = ['2021', '2022', '2023', '2024', '2025'];
const ANNUAL_REVENUE_B = [1587, 2264, 2161, 2894, 3809];
const ANNUAL_CAPEX_USD_B = [30.0, 36.3, 30.4, 30.0, 29.8];
const ANNUAL_DIVIDEND = [11.0, 11.0, 12.0, 14.0, 18.0];

function renderFundamentalChart() {
    createChart('fundamental-chart', {
        type: 'bar',
        data: {
            labels: QUARTER_LABELS,
            datasets: [{
                label: '營收 (十億台幣)',
                data: REVENUES_B,
                backgroundColor: 'rgba(59, 130, 246, 0.75)',
                yAxisID: 'y'
            }, {
                label: '毛利率 (%)',
                data: GROSS_MARGINS,
                type: 'line',
                borderColor: '#ef4444',
                backgroundColor: 'rgba(239,68,68,0.1)',
                fill: true,
                borderWidth: 3,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: '#ef4444',
                yAxisID: 'y1'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y:  { type: 'linear', position: 'left',  grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } },
                y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, min: 45, max: 72, title: { display: true, text: '毛利率 %' } }
            }
        }
    });
}

function renderEpsChart() {
    createChart('eps-chart', {
        type: 'bar',
        data: {
            labels: QUARTER_LABELS,
            datasets: [{
                label: '單季 EPS (NT$)',
                data: EPS_QUARTERLY,
                backgroundColor: EPS_QUARTERLY.map((v, i) => i > 0 && v > EPS_QUARTERLY[i-1] ? 'rgba(239,68,68,0.8)' : 'rgba(34,197,94,0.8)'),
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'NT$ / 股' } } }
        }
    });
}

function renderYoyChart() {
    // 同期對比：24Q1 vs 23Q1 等（使用近似值）
    const prevYearRevs = [508, 480, 546, 625, 592.64, 673.51, 759.69, 868.46, 839.25];
    const yoy = REVENUES_B.map((r, i) => prevYearRevs[i] ? ((r - prevYearRevs[i]) / prevYearRevs[i] * 100) : null);

    createChart('yoy-chart', {
        type: 'bar',
        data: {
            labels: QUARTER_LABELS,
            datasets: [{
                label: '營收年增率 YoY (%)',
                data: yoy,
                backgroundColor: yoy.map(v => v >= 0 ? 'rgba(59,130,246,0.8)' : 'rgba(239,68,68,0.8)'),
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'YoY %' } } }
        }
    });
}

function renderMarginStackChart() {
    createChart('margin-stack-chart', {
        type: 'line',
        data: {
            labels: QUARTER_LABELS,
            datasets: [
                { label: '毛利率', data: GROSS_MARGINS, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 2.5, tension: 0.35, pointRadius: 3 },
                { label: '營業利益率', data: OPERATING_MARGINS, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', borderWidth: 2.5, tension: 0.35, pointRadius: 3 },
                { label: '淨利率', data: NET_MARGINS, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', borderWidth: 2.5, tension: 0.35, pointRadius: 3 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, min: 30, max: 70, title: { display: true, text: 'Margin %' } }
            }
        }
    });
}

function renderCashflowCapexChart() {
    createChart('cashflow-capex-chart', {
        type: 'bar',
        data: {
            labels: ANNUAL_LABELS,
            datasets: [
                {
                    label: '營收 (十億台幣)',
                    data: ANNUAL_REVENUE_B,
                    backgroundColor: 'rgba(59,130,246,0.74)',
                    borderRadius: 4,
                    yAxisID: 'y'
                },
                {
                    label: '資本支出 (十億美元)',
                    data: ANNUAL_CAPEX_USD_B,
                    type: 'line',
                    borderColor: '#f59e0b',
                    borderWidth: 3,
                    tension: 0.25,
                    pointRadius: 4,
                    yAxisID: 'y1'
                },
                {
                    label: '每股現金股利 (NT$)',
                    data: ANNUAL_DIVIDEND,
                    type: 'line',
                    borderColor: '#10b981',
                    borderDash: [5, 4],
                    borderWidth: 2,
                    tension: 0.25,
                    pointRadius: 4,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } },
                y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'USD B / NT$' } }
            }
        }
    });
}

// ─── 技術面圖表 ────────────────────────────────────────────────
function renderTechnicalChart(data) {
    const labels = data.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);
    const closes = data.map(d => d.close);
    const bb = calculateBollingerBands(data, 20, 2);

    createChart('technical-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '收盤價', data: closes, borderColor: '#3b82f6', borderWidth: 2.5, tension: 0.1, pointRadius: 0, fill: false },
                { label: '中軌 (20MA)', data: bb.ma, borderColor: '#f59e0b', borderWidth: 1.5, tension: 0.1, pointRadius: 0, borderDash: [] },
                { label: '上軌', data: bb.upper, borderColor: '#10b981', borderDash: [4, 4], borderWidth: 1, tension: 0.1, pointRadius: 0, fill: false },
                { label: '下軌', data: bb.lower, borderColor: '#ef4444', borderDash: [4, 4], borderWidth: 1, tension: 0.1, pointRadius: 0, fill: '2' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });

    const kd = calculateKD(data);
    createChart('kd-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'K 值', data: kd.k, borderColor: '#3b82f6', borderWidth: 2, tension: 0.3, pointRadius: 0 },
                { label: 'D 值', data: kd.d, borderColor: '#f59e0b', borderWidth: 2, tension: 0.3, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                annotation: {},
                legend: { position: 'top' }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, min: 0, max: 100 }
            }
        }
    });
}

function renderVolumeChart(data) {
    const labels = data.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);
    const volumes = data.map(d => Math.round((d.volume || 0) / 1000)); // 千股
    const colors = data.map((d, i) => i === 0 ? 'rgba(59,130,246,0.7)' : (d.close >= data[i-1].close ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)'));

    createChart('volume-chart', {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: '成交量 (千股)', data: volumes, backgroundColor: colors, borderRadius: 2 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '千股' } }
            }
        }
    });
}

function renderRsiChart(data) {
    const labels = data.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);
    const rsi = calculateRSI(data, 14);

    createChart('rsi-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'RSI 14', data: rsi, borderColor: '#8b5cf6', borderWidth: 2.5, tension: 0.25, pointRadius: 0 },
                { label: '偏熱 70', data: labels.map(() => 70), borderColor: 'rgba(239,68,68,0.7)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0 },
                { label: '偏冷 30', data: labels.map(() => 30), borderColor: 'rgba(34,197,94,0.7)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

function renderMacdChart(data) {
    const labels = data.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);
    const macd = calculateMACD(data);

    createChart('macd-chart', {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Histogram',
                    data: macd.histogram,
                    backgroundColor: macd.histogram.map(v => v >= 0 ? 'rgba(239,68,68,0.72)' : 'rgba(34,197,94,0.72)'),
                    borderRadius: 2
                },
                { label: 'DIF', data: macd.dif, type: 'line', borderColor: '#3b82f6', borderWidth: 2, tension: 0.25, pointRadius: 0 },
                { label: 'DEA', data: macd.dea, type: 'line', borderColor: '#f59e0b', borderWidth: 2, tension: 0.25, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

// ─── 籌碼面圖表 ────────────────────────────────────────────────
function renderChipCostChart(data) {
    const canvasEl = document.getElementById('chip-cost-chart');
    if (!canvasEl) return;

    if (!data || data.length < 53) {
        const fb = document.createElement('div');
        fb.className = 'chart-fallback';
        fb.innerHTML = '<strong>法人成本資料暫時無法取得</strong><span>Yahoo Finance CORS proxy 未回應，請稍後按右上角「更新資料」重試。</span>';
        canvasEl.replaceWith(fb);
        return;
    }

    const labels = data.map(d => `${d.date.getFullYear()}/${d.date.getMonth()+1}`);
    const closes = data.map(d => d.close);
    const cost1Y = calculateMA(data, 52);
    // 需要至少 260 筆才有意義；資料不足時降級顯示已有長度的 MA
    const longPeriod = data.length >= 260 ? 260 : Math.max(104, data.length - 1);
    const cost5Y = calculateMA(data, longPeriod);

    createChart('chip-cost-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '台積電股價', data: closes, borderColor: '#3b82f6', borderWidth: 2, tension: 0.1, pointRadius: 0 },
                { label: '近1年法人成本線 (52週MA)', data: cost1Y, borderColor: '#f59e0b', borderWidth: 2, borderDash: [6, 3], tension: 0.4, pointRadius: 0 },
                { label: `長期法人底部 (${longPeriod}週MA)`, data: cost5Y, borderColor: '#ef4444', borderWidth: 2.5, tension: 0.4, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

function renderChipFlowChart(data) {
    // 共用 options，關鍵：intersect: false 讓區域懸停即顯示
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false }, // ← 區域懸停即顯示
        plugins: {
            legend: { position: 'top' },
            tooltip: {
                callbacks: {
                    label: ctx => ` ${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw.toLocaleString()} 張`
                }
            }
        },
        scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } } }
    };

    if (!data) {
        createChart('chip-flow-chart', {
            type: 'bar',
            data: {
                labels: ['資料載入中...'],
                datasets: [{ label: '等待資料', data: [0] }]
            },
            options: commonOptions
        });
        return;
    }

    createChart('chip-flow-chart', {
        type: 'bar',
        data: {
            labels: data.labels,
            datasets: [
                {
                    label: '外資買賣超 (張)',
                    data: data.foreign,
                    backgroundColor: data.foreign.map(v => v >= 0 ? 'rgba(239,68,68,0.8)' : 'rgba(34,197,94,0.8)'),
                    borderRadius: 2
                },
                {
                    label: '投信買賣超 (張)',
                    data: data.trust,
                    backgroundColor: 'rgba(59,130,246,0.75)',
                    borderRadius: 2
                },
                {
                    label: '自營商買賣超 (張)',
                    data: data.dealer,
                    backgroundColor: 'rgba(245,158,11,0.75)',
                    borderRadius: 2
                }
            ]
        },
        options: commonOptions
    });
}

function renderChipCumulativeChart(data) {
    if (!data) {
        createChart('chip-cumulative-chart', {
            type: 'line',
            data: {
                labels: ['資料載入中...'],
                datasets: [{ label: '等待資料', data: [0], borderColor: '#64748b' }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } }
            }
        });
        return;
    }

    const cumulative = arr => arr.reduce((series, value, index) => {
        series.push((series[index - 1] || 0) + value);
        return series;
    }, []);

    createChart('chip-cumulative-chart', {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [
                { label: '外資累積', data: cumulative(data.foreign), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 2.5, tension: 0.25, pointRadius: 0 },
                { label: '投信累積', data: cumulative(data.trust), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', borderWidth: 2.5, tension: 0.25, pointRadius: 0 },
                { label: '自營累積', data: cumulative(data.dealer), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 2.5, tension: 0.25, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${Math.round(ctx.raw).toLocaleString()} 張`
                    }
                }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '累積張數' } }
            }
        }
    });
}

// ─── 總經面圖表 ────────────────────────────────────────────────
function renderMacroChart(tsmData, twdData) {
    const minLength = Math.min(tsmData.length, twdData.length);
    const rTsm = tsmData.slice(-minLength);
    const rTwd = twdData.slice(-minLength);
    const labels = rTsm.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);

    createChart('macro-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '台積電 (2330.TW)', data: rTsm.map(d => d.close), borderColor: '#3b82f6', yAxisID: 'y', tension: 0.1, pointRadius: 0 },
                { label: 'USD/TWD 匯率', data: rTwd.map(d => d.close), borderColor: '#f59e0b', yAxisID: 'y1', tension: 0.1, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y:  { type: 'linear', position: 'left',  grid: { color: 'rgba(255,255,255,0.05)' } },
                y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false } }
            }
        }
    });
}

function renderSoxAdrChart(tsmData, soxData, adrData) {
    if (!tsmData?.length || !soxData?.length || !adrData?.length) {
        console.warn('SOX/ADR 資料不足'); return;
    }

    // 以「1年前」為共同起點
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);

    const since = arr => {
        const f = arr.filter(d => new Date(d.date) >= cutoff);
        return f.length > 2 ? f : arr.slice(-52);
    };

    const rTsm = since(tsmData);
    const rSox = since(soxData);
    const rAdr = since(adrData);

    // ── 建立統一時間軸：以資料最多的那組為主軸，其他插值對齊 ──
    // 用最長的那組作為 labels 基準
    const master = [rTsm, rSox, rAdr].reduce((a, b) => a.length >= b.length ? a : b);
    const labels = master.map(d => {
        const dt = new Date(d.date);
        return `${dt.getFullYear()}/${dt.getMonth()+1}/${dt.getDate()}`;
    });

    // 把任意陣列插值對齊到 master 長度
    const alignTo = (arr, masterArr) => {
        if (arr.length === masterArr.length) {
            // 長度相同，直接用
            const base = arr[0].close;
            return arr.map(d => +((d.close - base) / base * 100).toFixed(2));
        }
        // 長度不同：用線性插值對齊
        const base = arr[0].close;
        const result = [];
        for (let i = 0; i < masterArr.length; i++) {
            const targetTime = new Date(masterArr[i].date).getTime();
            // 找最接近的兩個點做插值
            let lo = arr[0], hi = arr[arr.length - 1];
            for (let j = 0; j < arr.length - 1; j++) {
                if (new Date(arr[j].date).getTime() <= targetTime &&
                    new Date(arr[j+1].date).getTime() >= targetTime) {
                    lo = arr[j]; hi = arr[j+1]; break;
                }
            }
            const t1 = new Date(lo.date).getTime();
            const t2 = new Date(hi.date).getTime();
            const frac = t2 === t1 ? 0 : (targetTime - t1) / (t2 - t1);
            const close = lo.close + (hi.close - lo.close) * frac;
            result.push(+((close - base) / base * 100).toFixed(2));
        }
        return result;
    };

    const tsmPct = alignTo(rTsm, master);
    const soxPct = alignTo(rSox, master);
    const adrPct = alignTo(rAdr, master);

    createChart('sox-adr-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '台積電 (2330.TW)',  data: tsmPct, borderColor: '#ef4444', borderWidth: 2.5, tension: 0.1, pointRadius: 0 },
                { label: '台積電 ADR (TSM)',  data: adrPct, borderColor: '#3b82f6', borderWidth: 2,   tension: 0.1, pointRadius: 0 },
                { label: 'SOXX 半導體 ETF',  data: soxPct, borderColor: '#10b981', borderWidth: 2,   tension: 0.1, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8' } },
                tooltip: {
                    callbacks: {
                        title: items => labels[items[0].dataIndex] || '',
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw}%`
                    }
                }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 12, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', callback: v => v + '%' },
                    title: { display: true, text: '累積報酬率 (%)', color: '#94a3b8' }
                }
            }
        }
    });
}

function updateMacroSnapshot(tsmData, twdData, soxData, adrData) {
    const setText = (id, text, numericValue = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = text;
        if (numericValue !== null) {
            el.style.color = numericValue >= 0 ? '#ef4444' : '#22c55e';
        }
    };

    const pctReturn = (data) => {
        if (!data || data.length < 2) return null;
        const first = data[0].close;
        const last = data[data.length - 1].close;
        if (!first || !last) return null;
        return ((last - first) / first) * 100;
    };

    const tsmReturn = pctReturn(tsmData);
    const adrReturn = pctReturn(adrData);
    const soxReturn = pctReturn(soxData);

    if (tsmReturn !== null) setText('macro-tsm-return', `${tsmReturn >= 0 ? '+' : ''}${tsmReturn.toFixed(1)}%`, tsmReturn);
    if (adrReturn !== null) setText('macro-adr-return', `${adrReturn >= 0 ? '+' : ''}${adrReturn.toFixed(1)}%`, adrReturn);
    if (soxReturn !== null) setText('macro-sox-return', `${soxReturn >= 0 ? '+' : ''}${soxReturn.toFixed(1)}%`, soxReturn);

    if (tsmData.length > 2 && twdData.length > 2) {
        const minLength = Math.min(tsmData.length, twdData.length);
        const tsmReturns = toReturns(tsmData.slice(-minLength).map(d => d.close));
        const twdReturns = toReturns(twdData.slice(-minLength).map(d => d.close));
        const corr = correlation(tsmReturns, twdReturns);
        const corrEl = document.getElementById('macro-fx-corr');
        if (corrEl && Number.isFinite(corr)) {
            corrEl.innerText = corr.toFixed(2);
            corrEl.style.color = Math.abs(corr) >= 0.35 ? '#f59e0b' : '#94a3b8';
        }
    }
}

// ─── 產業面圖表 ────────────────────────────────────────────────
function renderIndustryChart() {
    createChart('industry-pie-chart', {
        type: 'doughnut',
        data: {
            labels: ['3奈米 (N3/N2)', '5奈米 (N5)', '7奈米 (N7)', '16/20奈米', '28奈米以上'],
            datasets: [{
                data: [26, 34, 16, 9, 15],
                backgroundColor: ['#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#e0f2fe'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: { legend: { position: 'right' } }
        }
    });

    createChart('market-share-chart', {
        type: 'doughnut',
        data: {
            labels: ['TSMC (台積電)', 'Samsung', 'SMIC (中芯)', 'UMC (聯電)', 'GlobalFoundries', 'Others'],
            datasets: [{
                data: [61.7, 11.0, 5.7, 5.7, 5.1, 10.8],
                backgroundColor: ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#64748b'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: { legend: { position: 'right' } }
        }
    });

    // 平台業務收入結構
    createChart('platform-chart', {
        type: 'bar',
        data: {
            labels: ['2020', '2021', '2022', '2023', '2024', '2025', '2026(E)'],
            datasets: [
                { label: 'HPC (AI/高效能運算)', data: [33, 41, 42, 43, 51, 59, 63], backgroundColor: 'rgba(59,130,246,0.85)', borderRadius: 4 },
                { label: '智慧型手機', data: [48, 44, 38, 38, 33, 28, 26], backgroundColor: 'rgba(245,158,11,0.85)', borderRadius: 4 },
                { label: 'IoT / 汽車電子 / 其他', data: [19, 15, 20, 19, 16, 13, 11], backgroundColor: 'rgba(100,116,139,0.85)', borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' }, max: 100, title: { display: true, text: '佔比 %' } }
            }
        }
    });

    createChart('advanced-node-chart', {
        type: 'line',
        data: {
            labels: ['2021', '2022', '2023', '2024', '2025', '2026(E)'],
            datasets: [
                { label: '7nm 以下先進製程', data: [50, 53, 58, 69, 74, 78], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.14)', fill: true, borderWidth: 3, tension: 0.35, pointRadius: 4 },
                { label: '成熟/特殊製程', data: [50, 47, 42, 31, 26, 22], borderColor: '#64748b', borderDash: [5, 4], borderWidth: 2, tension: 0.35, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '營收占比 %' } }
            }
        }
    });

    createChart('packaging-chart', {
        type: 'bar',
        data: {
            labels: ['CoWoS', 'SoIC', 'InFO', '矽光子', '特殊製程'],
            datasets: [{
                label: '策略重要性',
                data: [95, 82, 72, 64, 68],
                backgroundColor: ['#ef4444', '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b'],
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.03)' } }
            }
        }
    });

    createChart('competitive-radar-chart', {
        type: 'radar',
        data: {
            labels: ['先進製程', '先進封裝', '良率/量產', '客戶信任', '資本能力', '全球彈性'],
            datasets: [
                { label: 'TSMC', data: [96, 94, 95, 97, 92, 84], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.18)', pointBackgroundColor: '#ef4444' },
                { label: 'Samsung Foundry', data: [78, 70, 68, 72, 82, 76], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', pointBackgroundColor: '#3b82f6' },
                { label: 'Intel Foundry', data: [70, 66, 58, 62, 86, 80], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)', pointBackgroundColor: '#f59e0b' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: {
                r: {
                    min: 0,
                    max: 100,
                    ticks: { display: false, stepSize: 20 },
                    angleLines: { color: 'rgba(255,255,255,0.08)' },
                    grid: { color: 'rgba(255,255,255,0.08)' },
                    pointLabels: { color: '#cbd5e1', font: { size: 12 } }
                }
            }
        }
    });
}

// ─── 展望面圖表 ────────────────────────────────────────────────
function renderOutlookChart() {
    createChart('outlook-capex-chart', {
        type: 'bar',
        data: {
            labels: ['2021', '2022', '2023', '2024', '2025', '2026(E)', '2027(E)', '2028(E)'],
            datasets: [{
                label: '資本支出 (十億美元)',
                data: [30.0, 36.3, 30.4, 30.0, 38.0, 42.0, 46.0, 52.0],
                backgroundColor: (ctx) => {
                    const v = ctx.raw;
                    return v > 40 ? 'rgba(239,68,68,0.8)' : 'rgba(16,185,129,0.8)';
                },
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億美元 (USD B)' } } }
        }
    });

    // 長期營收預測
    createChart('outlook-revenue-chart', {
        type: 'line',
        data: {
            labels: ['2022', '2023', '2024', '2025', '2026(E)', '2027(E)', '2028(E)', '2029(E)', '2030(E)'],
            datasets: [{
                label: '年度營收 (十億台幣)',
                data: [2264, 2161, 2894, 3809, 4700, 5500, 6500, 7600, 9000],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59,130,246,0.15)',
                fill: true,
                borderWidth: 3,
                tension: 0.4,
                pointRadius: 5,
                pointBackgroundColor: '#3b82f6'
            }, {
                label: '保守預估',
                data: [2264, 2161, 2894, 3809, 4400, 5000, 5700, 6500, 7500],
                borderColor: '#94a3b8',
                borderDash: [5, 5],
                borderWidth: 2,
                tension: 0.4,
                pointRadius: 0,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } }
            }
        }
    });

    createChart('outlook-scenario-chart', {
        type: 'line',
        data: {
            labels: ['2025', '2026(E)', '2027(E)', '2028(E)', '2029(E)', '2030(E)'],
            datasets: [
                { label: '保守：AI 放緩但製程升級延續', data: [3809, 4400, 5000, 5700, 6500, 7500], borderColor: '#94a3b8', borderDash: [5, 4], borderWidth: 2, tension: 0.35, pointRadius: 3 },
                { label: '基準：AI/HPC 持續擴產', data: [3809, 4700, 5500, 6500, 7600, 9000], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.13)', fill: true, borderWidth: 3, tension: 0.35, pointRadius: 4 },
                { label: '樂觀：ASIC 與先進封裝供給釋放', data: [3809, 5000, 6100, 7600, 9300, 11200], borderColor: '#ef4444', borderWidth: 3, tension: 0.35, pointRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } }
            }
        }
    });
}

// ─── 風險情境 ──────────────────────────────────────────────────
function renderRiskChart() {
    createChart('risk-radar-chart', {
        type: 'radar',
        data: {
            labels: ['AI 需求循環', '客戶集中', '先進節點良率', '海外廠成本', '匯率波動', '地緣限制'],
            datasets: [{
                label: '追蹤優先度',
                data: [88, 72, 76, 70, 62, 84],
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245,158,11,0.18)',
                pointBackgroundColor: '#f59e0b'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                r: {
                    min: 0,
                    max: 100,
                    ticks: { display: false, stepSize: 20 },
                    angleLines: { color: 'rgba(255,255,255,0.08)' },
                    grid: { color: 'rgba(255,255,255,0.08)' },
                    pointLabels: { color: '#cbd5e1', font: { size: 12 } }
                }
            }
        }
    });
}

// ─── 情緒分析 ──────────────────────────────────────────────────
function analyzeSentiment(news) {
    const positiveWords = ['量產', '突破', '創高', '買進', '目標價', '看好', '成長', '法說會', '獲利', '大漲', '雙增', '上修', '優於', '強勁', '受惠', 'beat', 'upgrade', 'outperform', 'record'];
    const negativeWords = ['砍單', '衰退', '延遲', '賣出', '看跌', '下修', '利空', '大跌', '外資提款', '減少', '不如預期', '放緩', 'downgrade', 'underperform', 'miss', 'cut'];

    let posCount = 0, negCount = 0;
    const posHits = new Set();
    const negHits = new Set();
    news.forEach(n => {
        const text = (n.title + ' ' + (n.summary || '')).toLowerCase();
        positiveWords.forEach(w => {
            if (text.includes(w.toLowerCase())) {
                posCount++;
                posHits.add(w);
            }
        });
        negativeWords.forEach(w => {
            if (text.includes(w.toLowerCase())) {
                negCount++;
                negHits.add(w);
            }
        });
    });

    let score = 50;
    if (posCount + negCount > 0) {
        score = 50 + ((posCount - negCount) / (posCount + negCount)) * 50;
    }

    const scoreEl = document.getElementById('sentiment-score');
    const labelEl = document.getElementById('sentiment-label');
    const needleEl = document.getElementById('sentiment-needle');

    if (scoreEl) scoreEl.innerText = score.toFixed(0);
    if (needleEl) needleEl.style.left = score + '%';

    let color = '#94a3b8', label = '中立 (Neutral)';
    if (score >= 65)      { color = '#ef4444'; label = '極度樂觀 (Bullish)'; }
    else if (score >= 55) { color = '#f87171'; label = '偏多 (Positive)'; }
    else if (score <= 35) { color = '#22c55e'; label = '極度悲觀 (Bearish)'; }
    else if (score <= 45) { color = '#4ade80'; label = '偏空 (Negative)'; }

    if (scoreEl) scoreEl.style.color = color;
    if (labelEl) { labelEl.innerText = label; labelEl.style.color = color; }

    const keywordsEl = document.getElementById('sentiment-keywords');
    if (keywordsEl) {
        const renderTags = (items, fallback) => {
            const tags = [...items];
            if (tags.length === 0) return `<span>${fallback}</span>`;
            return tags.map(item => `<span>${escapeHtml(item)}</span>`).join('');
        };

        keywordsEl.innerHTML = `
            <h4>情緒關鍵字命中</h4>
            <div class="keyword-grid">
                <div class="keyword-bucket">
                    <h5>偏多訊號 (${posCount})</h5>
                    <div class="keyword-tags">${renderTags(posHits, '暫無明顯偏多字詞')}</div>
                </div>
                <div class="keyword-bucket">
                    <h5>偏空訊號 (${negCount})</h5>
                    <div class="keyword-tags">${renderTags(negHits, '暫無明顯偏空字詞')}</div>
                </div>
            </div>
        `;
    }
}

function calculateRSI(data, period = 14) {
    const closes = data.map(d => d.close);
    const rsi = Array(closes.length).fill(null);
    if (closes.length <= period) return rsi;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }

    return rsi;
}

function calculateEMA(values, period) {
    const multiplier = 2 / (period + 1);
    const ema = Array(values.length).fill(null);
    let previous = null;

    values.forEach((value, index) => {
        if (value === null || value === undefined) return;
        if (previous === null) {
            previous = value;
        } else {
            previous = (value - previous) * multiplier + previous;
        }
        ema[index] = previous;
    });

    return ema;
}

function calculateMACD(data) {
    const closes = data.map(d => d.close);
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const dif = closes.map((_, index) => {
        if (ema12[index] === null || ema26[index] === null) return null;
        return ema12[index] - ema26[index];
    });
    const dea = calculateEMA(dif, 9);
    const histogram = dif.map((value, index) => {
        if (value === null || dea[index] === null) return null;
        return value - dea[index];
    });

    return { dif, dea, histogram };
}

function toReturns(values) {
    const returns = [];
    for (let i = 1; i < values.length; i++) {
        if (!values[i - 1] || !values[i]) continue;
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
    return returns;
}

function correlation(a, b) {
    const length = Math.min(a.length, b.length);
    if (length < 2) return NaN;
    const x = a.slice(-length);
    const y = b.slice(-length);
    const meanX = x.reduce((sum, value) => sum + value, 0) / length;
    const meanY = y.reduce((sum, value) => sum + value, 0) / length;
    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < length; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        numerator += dx * dy;
        denomX += dx * dx;
        denomY += dy * dy;
    }

    return numerator / Math.sqrt(denomX * denomY);
}
