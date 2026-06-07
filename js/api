// Global configuration
const SYMBOL = "2330.TW"; // Yahoo Finance symbol for TSMC Taiwan
const TWSE_SYMBOL = "2330"; // FinMind symbol for TSMC
const ADR_SYMBOL = "TSM"; // TSMC ADR on NYSE
const SOX_SYMBOL = "SOXX"; // iShares Semiconductor ETF
const CORS_PROXY = "https://api.allorigins.win/raw?url=";
const CORS_PROXY2 = "https://thingproxy.freeboard.io/fetch/"; // Fallback
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";

/**
 * 取得最新報價 (Yahoo Finance ）
 */
async function fetchWithFallback(url) {
    // 嘗試主要 Proxy
    try {
        const res = await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`);
        if (res.ok) {
            const text = await res.text();
            if (text && !text.includes('Request Timeout') && !text.includes('error code')) {
                return JSON.parse(text);
            }
        }
    } catch(e) {}
    // 嘗試備用 Proxy
    try {
        const res2 = await fetch(`${CORS_PROXY2}${url}`);
        if (res2.ok) return await res2.json();
    } catch(e) {}
    return null;
}

async function fetchQuoteSummary() {
    try {
        const url = `${YAHOO_FINANCE_BASE}/chart/${SYMBOL}?range=1d&interval=1d`;
        const data = await fetchWithFallback(url);
        if (!data) return null;
        
        const result = data.chart.result[0];
        const meta = result.meta;
        
        return {
            price: meta.regularMarketPrice,
            change: meta.regularMarketPrice - meta.chartPreviousClose,
            changePercent: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100
        };
    } catch (error) {
        console.error("Error fetching quote:", error);
        return null;
    }
}

/**
 * 取得歷史 K 線資料
 */
const YAHOO_FINANCE_BASE = "https://query2.finance.yahoo.com/v8/finance";

async function fetchHistoricalData(range = "5y", interval = "1d", customSymbol = null) {
    try {
        const targetSymbol = customSymbol || SYMBOL;
        const url = `${YAHOO_FINANCE_BASE}/chart/${targetSymbol}?range=${range}&interval=${interval}`;
        const data = await fetchWithFallback(url);
        if (!data) return [];
        
        const result = data.chart.result[0];
        if (!result || !result.timestamp) return [];
        const timestamps = result.timestamp;
        const quote = result.indicators.quote[0];
        
        return timestamps.map((time, index) => ({
            date: new Date(time * 1000),
            open: quote.open[index],
            high: quote.high[index],
            low: quote.low[index],
            close: quote.close[index],
            volume: quote.volume[index]
        })).filter(item => item.close !== null);
    } catch (error) {
        console.error("Error fetching historical data:", error);
        return [];
    }
}

/**
 * 取得財報基本面資料 (FinMind)
 */
async function fetchFundamentals() {
    try {
        const date = new Date();
        date.setMonth(date.getMonth() - 1);
        const startDate = date.toISOString().split('T')[0];
        
        const perUrl = `${FINMIND_BASE}?dataset=TaiwanStockPER&data_id=${TWSE_SYMBOL}&start_date=${startDate}`;
        const perRes = await fetch(perUrl);
        const perData = await perRes.json();
        let latestPer = '--';
        let dividendYield = '--';
        let roe = '--';
        if (perData.data && perData.data.length > 0) {
            const latest = perData.data[perData.data.length - 1];
            latestPer = latest.PER;
            dividendYield = latest.dividend_yield;
            if (latest.PER && latest.PBR) {
                roe = ((latest.PBR / latest.PER) * 100).toFixed(2);
            }
        }
        
        const yearAgo = new Date();
        yearAgo.setFullYear(yearAgo.getFullYear() - 1);
        const epsUrl = `${FINMIND_BASE}?dataset=TaiwanStockFinancialStatements&data_id=${TWSE_SYMBOL}&start_date=${yearAgo.toISOString().split('T')[0]}`;
        const epsRes = await fetch(epsUrl);
        const epsJson = await epsRes.json();
        
        const epsData = (epsJson.data || []).filter(item => item.type === "EPS");
        // 近四季 EPS 加總 (TTM = Trailing Twelve Months)
        let totalEps = 0;
        if (epsData.length > 0) {
            const last4 = epsData.slice(-4);
            totalEps = last4.reduce((sum, item) => sum + parseFloat(item.value), 0);
            totalEps = Math.round(totalEps * 100) / 100;
        }

        const shareUrl = `${FINMIND_BASE}?dataset=TaiwanStockShareholding&data_id=${TWSE_SYMBOL}&start_date=${startDate}`;
        const shareRes = await fetch(shareUrl);
        const shareJson = await shareRes.json();
        
        let marketCap = 0;
        let foreignRatio = '--';
        if (shareJson.data && shareJson.data.length > 0) {
            const latestShare = shareJson.data[shareJson.data.length - 1];
            const quote = await fetchQuoteSummary();
            if(quote && latestShare.NumberOfSharesIssued) {
                marketCap = quote.price * latestShare.NumberOfSharesIssued;
            }
            foreignRatio = latestShare.ForeignInvestmentSharesRatio;
        }
        
        return {
            peRatio: latestPer,
            eps: totalEps,
            marketCap: marketCap,
            foreignRatio: foreignRatio,
            dividendYield: dividendYield,
            roe: roe
        };
    } catch (error) {
        console.error("Error fetching fundamentals:", error);
        return null;
    }
}

/**
 * 取得三大法人買賣超 (FinMind)
 */
async function fetchChipFlow() {
    try {
        const date = new Date();
        date.setDate(date.getDate() - 40);
        const startDate = date.toISOString().split('T')[0];
        const url = `${FINMIND_BASE}?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${TWSE_SYMBOL}&start_date=${startDate}`;
        const response = await fetch(url);
        const json = await response.json();
        
        const daysMap = {};
        if(json.data) {
            json.data.forEach(item => {
                if (!daysMap[item.date]) {
                    daysMap[item.date] = { foreign: 0, trust: 0, dealer: 0 };
                }
                const net = item.buy - item.sell;
                if (item.name === "Foreign_Investor") {
                    daysMap[item.date].foreign += net;
                } else if (item.name === "Investment_Trust") {
                    daysMap[item.date].trust += net;
                } else if (item.name.startsWith("Dealer")) {
                    daysMap[item.date].dealer += net;
                }
            });
        }
        
        const sortedDates = Object.keys(daysMap).sort();
        const latest30 = sortedDates.slice(-30);
        
        return {
            labels: latest30.map(d => d.substring(5)),
            foreign: latest30.map(d => daysMap[d].foreign / 1000),
            trust: latest30.map(d => daysMap[d].trust / 1000),
            dealer: latest30.map(d => daysMap[d].dealer / 1000)
        };
    } catch (error) {
        console.error("Error fetching chip flow:", error);
        return null;
    }
}

/**
 * 取得新聞 (Yahoo)
 */
async function fetchNews() {
    try {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${SYMBOL}&newsCount=12`;
        const data = await fetchWithFallback(url);
        return data.news || [];
    } catch (error) {
        console.error("Error fetching news:", error);
        return [];
    }
}

function calculateMA(data, period) {
    const ma = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            ma.push(null);
            continue;
        }
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += data[i - j].close;
        }
        ma.push(sum / period);
    }
    return ma;
}

function calculateBollingerBands(data, period = 20, multiplier = 2) {
    const ma = calculateMA(data, period);
    const upper = [];
    const lower = [];
    
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            upper.push(null);
            lower.push(null);
            continue;
        }
        let sumSq = 0;
        for (let j = 0; j < period; j++) {
            sumSq += Math.pow(data[i - j].close - ma[i], 2);
        }
        const stdDev = Math.sqrt(sumSq / period);
        upper.push(ma[i] + multiplier * stdDev);
        lower.push(ma[i] - multiplier * stdDev);
    }
    return { upper, lower, ma };
}

function calculateKD(data, period = 9) {
    const kData = [];
    const dData = [];
    let prevK = 50;
    let prevD = 50;
    
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            kData.push(null);
            dData.push(null);
            continue;
        }
        
        let minLow = data[i].low;
        let maxHigh = data[i].high;
        for (let j = 0; j < period; j++) {
            if (data[i - j].low < minLow) minLow = data[i - j].low;
            if (data[i - j].high > maxHigh) maxHigh = data[i - j].high;
        }
        
        let rsv = 50;
        if (maxHigh > minLow) {
            rsv = ((data[i].close - minLow) / (maxHigh - minLow)) * 100;
        }
        
        const currentK = (2 / 3) * prevK + (1 / 3) * rsv;
        const currentD = (2 / 3) * prevD + (1 / 3) * currentK;
        
        kData.push(currentK);
        dData.push(currentD);
        
        prevK = currentK;
        prevD = currentD;
    }
    
    return { k: kData, d: dData };
}
