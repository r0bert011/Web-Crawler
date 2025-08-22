/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from "@google/genai";

// --- CONSTANTS ---
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 15 * 60 * 1000; // 15 minutes
const REQUEST_DELAY_MS = 2000; // 2 seconds
const SESSION_KEY_PREFIX = 'crawlSession_';

// --- TYPES ---
interface CrawledLink {
    text: string;
    url: string;
}

interface CrawlResult {
    id: number;
    url: string;
    summary: string;
    links: CrawledLink[];
    crawledAt: string;
}

interface CrawlSession {
    startUrl: string;
    maxPages: number;
    queue: string[];
    visited: string[];
    batchCounter: number;
    pagesCrawled: number;
}

// --- STATE ---
let history: CrawlResult[] = [];
let isLoading = false;
let currentSession: CrawlSession | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;

// --- DOM ELEMENTS ---
const crawlForm = document.getElementById('crawl-form') as HTMLFormElement;
const urlInput = document.getElementById('url-input') as HTMLInputElement;
const maxPagesInput = document.getElementById('max-pages-input') as HTMLInputElement;
const crawlButton = document.getElementById('crawl-button') as HTMLButtonElement;
const crawlButtonText = crawlButton.querySelector('.button-text') as HTMLSpanElement;
const loader = crawlButton.querySelector('.loader') as HTMLDivElement;
const errorMessage = document.getElementById('error-message') as HTMLParagraphElement;

const statusSection = document.getElementById('crawl-status-section') as HTMLElement;
const statusMessage = document.getElementById('crawl-status-message') as HTMLParagraphElement;

const resultsSection = document.getElementById('results-section') as HTMLElement;
const crawledUrlEl = document.getElementById('crawled-url') as HTMLParagraphElement;
const contentSummaryEl = document.getElementById('content-summary') as HTMLParagraphElement;
const extractedLinksEl = document.getElementById('extracted-links') as HTMLUListElement;

const historySection = document.getElementById('history-section') as HTMLElement;
const historyList = document.getElementById('history-list') as HTMLUListElement;
const noHistoryMessage = document.getElementById('no-history-message') as HTMLParagraphElement;

const resumeModal = document.getElementById('resume-modal') as HTMLDivElement;
const resumeCrawlBtn = document.getElementById('resume-crawl-btn') as HTMLButtonElement;
const restartCrawlBtn = document.getElementById('restart-crawl-btn') as HTMLButtonElement;


// --- GEMINI API ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const model = "gemini-2.5-flash";

const CRAWL_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        summary: { type: Type.STRING, description: "Eine detaillierte, aber prägnante Zusammenfassung des Hauptinhalts der Webseite." },
        links: {
            type: Type.ARRAY,
            description: "Ein Array der 5 wichtigsten oder relevantesten Hyperlinks, die auf der Seite gefunden wurden.",
            items: {
                type: Type.OBJECT,
                properties: {
                    text: { type: Type.STRING, description: "Der Ankertext des Links." },
                    url: { type: Type.STRING, description: "Die absolute URL des Links." },
                },
                required: ["text", "url"],
            },
        },
    },
    required: ["summary", "links"],
};

// --- HELPER FUNCTIONS ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getSessionKey(url: string): string {
    try {
        return `${SESSION_KEY_PREFIX}${new URL(url).hostname}`;
    } catch {
        return `${SESSION_KEY_PREFIX}${url.replace(/[^a-zA-Z0-9]/g, '_')}`;
    }
}

function saveSession(session: CrawlSession) {
    localStorage.setItem(getSessionKey(session.startUrl), JSON.stringify(session));
}

function loadSession(url: string): CrawlSession | null {
    const savedSession = localStorage.getItem(getSessionKey(url));
    return savedSession ? JSON.parse(savedSession) : null;
}

function clearSession(url: string) {
    localStorage.removeItem(getSessionKey(url));
}

// --- UI FUNCTIONS ---
function setLoading(loading: boolean, message?: string) {
    isLoading = loading;
    crawlButton.disabled = loading;
    urlInput.disabled = loading;
    maxPagesInput.disabled = loading;
    loader.hidden = !loading;
    crawlButtonText.textContent = message || (loading ? 'Crawling...' : 'Crawl starten');

    if (loading) errorMessage.textContent = '';
}

function updateStatus(message: string) {
    statusSection.hidden = false;
    statusMessage.innerHTML = message;
}

function startCountdown(duration: number) {
    let timeLeft = duration;
    if (countdownInterval) clearInterval(countdownInterval);

    const update = () => {
        const minutes = Math.floor(timeLeft / (60 * 1000));
        const seconds = Math.floor((timeLeft % (60 * 1000)) / 1000);
        updateStatus(`Batch abgeschlossen. Pausiere...<br>Nächster Batch startet in <strong>${minutes}m ${seconds}s</strong>`);
        timeLeft -= 1000;
        if (timeLeft < 0) {
            if (countdownInterval) clearInterval(countdownInterval);
            processQueue();
        }
    };
    update();
    countdownInterval = setInterval(update, 1000);
}

function renderResult(result: CrawlResult | null) {
    if (!result) {
        resultsSection.hidden = true;
        return;
    }
    resultsSection.hidden = false;
    crawledUrlEl.textContent = result.url;
    contentSummaryEl.textContent = result.summary;
    extractedLinksEl.innerHTML = result.links.map(link =>
        `<li><a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.text}</a></li>`
    ).join('');
}

function renderHistory() {
    if (history.length === 0) {
        noHistoryMessage.hidden = false;
        historyList.hidden = true;
        return;
    }
    noHistoryMessage.hidden = true;
    historyList.hidden = false;
    historyList.innerHTML = '';
    history.slice().reverse().forEach(item => {
        const listItem = document.createElement('li');
        listItem.className = 'history-item';
        listItem.innerHTML = `
            <div class="history-info">
                <p class="url">${item.url}</p>
                <p class="date">Gecrawlt am: ${new Date(item.crawledAt).toLocaleString('de-DE')}</p>
            </div>
            <div class="history-actions">
                 <button class="delete-btn delete" data-id="${item.id}" aria-label="Crawl-Ergebnis für ${item.url} löschen">Löschen</button>
            </div>`;
        historyList.append(listItem);
    });
}

function saveHistory() {
    localStorage.setItem('crawlHistory', JSON.stringify(history));
}

function loadHistory() {
    const savedHistory = localStorage.getItem('crawlHistory');
    if (savedHistory) history = JSON.parse(savedHistory);
    renderHistory();
}

// --- CORE CRAWLING LOGIC ---

function saveResultAsJson(result: CrawlResult) {
    const dataStr = JSON.stringify(result, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const a = document.createElement('a');
    a.href = url;
    const safeFilename = result.url.replace(/[^a-zA-Z0-9]/g, '_');
    a.download = `crawl-${safeFilename}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function processQueue() {
    if (!currentSession) return;

    setLoading(true);
    const startHostname = new URL(currentSession.startUrl).hostname;

    while (currentSession.queue.length > 0 && currentSession.pagesCrawled < currentSession.maxPages) {
        if (currentSession.batchCounter >= BATCH_SIZE) {
            currentSession.batchCounter = 0;
            saveSession(currentSession);
            startCountdown(BATCH_PAUSE_MS);
            return; // Pause execution, countdown will resume it
        }

        const currentUrl = currentSession.queue.shift()!;
        if (currentSession.visited.includes(currentUrl)) {
            continue;
        }

        try {
            updateStatus(`[${currentSession.pagesCrawled + 1}/${currentSession.maxPages}] Crawle Seite: ${currentUrl}...`);
            
            const response = await ai.models.generateContent({
                model,
                contents: `Analysiere die URL ${currentUrl} und gib eine JSON-Zusammenfassung und die 5 wichtigsten Links zurück.`,
                config: { responseMimeType: "application/json", responseSchema: CRAWL_SCHEMA },
            });
            const resultData = JSON.parse(response.text);

            const replacementRegex = /gohighlevel|highlevel/gi;
            const processedSummary = resultData.summary.replace(replacementRegex, 'mightytools');
            const processedLinks: CrawledLink[] = resultData.links.map((link: CrawledLink) => ({
                text: link.text.replace(replacementRegex, 'mightytools'),
                url: link.url,
            }));

            const newResult: CrawlResult = {
                id: Date.now(),
                url: currentUrl,
                summary: processedSummary,
                links: processedLinks,
                crawledAt: new Date().toISOString(),
            };

            renderResult(newResult);
            saveResultAsJson(newResult);
            history.push(newResult);
            saveHistory();
            renderHistory();

            currentSession.visited.push(currentUrl);
            currentSession.pagesCrawled++;
            currentSession.batchCounter++;

            processedLinks.forEach(link => {
                try {
                    const absoluteUrl = new URL(link.url, currentUrl).href;
                    if (new URL(absoluteUrl).hostname === startHostname && !currentSession.visited.includes(absoluteUrl) && !currentSession.queue.includes(absoluteUrl)) {
                        currentSession.queue.push(absoluteUrl);
                    }
                } catch (e) { /* ignore invalid URLs */ }
            });

            saveSession(currentSession);
            
            updateStatus(`Warte ${REQUEST_DELAY_MS / 1000}s, um Ratenbegrenzung zu vermeiden...`);
            await sleep(REQUEST_DELAY_MS);

        } catch (error: any) {
            console.error("Crawl fehlgeschlagen:", error);
            const errorMessageText = error.message.includes('429') 
                ? 'API-Ratenlimit erreicht. Der Prozess wird pausiert. Bitte versuchen Sie es später erneut.' 
                : 'Das Crawlen der URL ist fehlgeschlagen. Seite übersprungen.';
            errorMessage.textContent = errorMessageText;
            currentSession.visited.push(currentUrl); // Mark as visited to avoid retrying
            saveSession(currentSession);
            await sleep(5000); // Wait longer on error
        }
    }

    // Crawl finished
    updateStatus(`Crawl abgeschlossen. ${currentSession.pagesCrawled} Seiten verarbeitet.`);
    clearSession(currentSession.startUrl);
    setLoading(false);
}

function startCrawl(url: string, maxPages: number, fromScratch = false) {
    if (fromScratch) clearSession(url);

    currentSession = loadSession(url);
    if (!currentSession) {
        currentSession = {
            startUrl: url,
            maxPages: maxPages,
            queue: [url],
            visited: [],
            batchCounter: 0,
            pagesCrawled: 0,
        };
        saveSession(currentSession);
    }
    
    processQueue();
}

// --- EVENT LISTENERS ---
function setupEventListeners() {
    crawlForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = urlInput.value.trim();
        if (!url || isLoading) return;

        const session = loadSession(url);
        if (session && session.queue.length > 0) {
            resumeModal.hidden = false;
        } else {
            const maxPages = parseInt(maxPagesInput.value, 10);
            startCrawl(url, maxPages, true);
        }
    });

    resumeCrawlBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        const maxPages = parseInt(maxPagesInput.value, 10);
        resumeModal.hidden = true;
        startCrawl(url, maxPages, false);
    });

    restartCrawlBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        const maxPages = parseInt(maxPagesInput.value, 10);
        resumeModal.hidden = true;
        startCrawl(url, maxPages, true);
    });

    historyList.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.delete-btn')) {
            const button = target.closest('.delete-btn') as HTMLButtonElement;
            const id = Number(button.dataset.id);
            if (id) {
                history = history.filter(item => item.id !== id);
                saveHistory();
                renderHistory();
            }
        }
    });
}

// --- INITIALIZATION ---
function init() {
    loadHistory();
    setupEventListeners();
}

init();
