
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from "@google/genai";

// --- CONSTANTS ---
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 3 * 60 * 1000; // 3 minutes
const REQUEST_DELAY_MS = 2000; // 2 seconds
const SESSION_KEY_PREFIX = 'crawlSession_';
const SITEMAP_URL = 'https://help.gohighlevel.com/support/sitemap.xml';
const PREVIOUS_SITEMAP_DATA_KEY = 'previousSitemapData';


// --- TYPES ---
interface CrawledLink {
    text: string;
    url: string;
}

interface CrawledImage {
    src: string;
    alt: string;
}

interface CrawlResult {
    id: number;
    url: string;
    fullContent: string;
    images: CrawledImage[];
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

interface SitemapEntry {
    url: string;
    lastmod: string;
}

// --- STATE ---
let history: CrawlResult[] = [];
let isLoading = false;
let currentSession: CrawlSession | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let sitemapNewUrls: string[] = [];
let sitemapUpdatedUrls: string[] = [];
let allSitemapUrls: string[] = [];


// --- DOM ELEMENTS ---
const crawlForm = document.getElementById('crawl-form') as HTMLFormElement;
const urlInput = document.getElementById('url-input') as HTMLInputElement;
const maxPagesInput = document.getElementById('max-pages-input') as HTMLInputElement;
const crawlButton = document.getElementById('crawl-button') as HTMLButtonElement;
const crawlButtonText = crawlButton.querySelector('.button-text') as HTMLSpanElement;
const loader = crawlButton.querySelector('.loader') as HTMLDivElement;
const errorMessage = document.getElementById('error-message') as HTMLParagraphElement;

const sitemapInfo = document.getElementById('sitemap-info') as HTMLParagraphElement;
const loadSitemapBtn = document.getElementById('load-sitemap-btn') as HTMLButtonElement;
const sitemapResults = document.getElementById('sitemap-results') as HTMLDivElement;
const sitemapSummary = document.getElementById('sitemap-summary') as HTMLParagraphElement;
const newUrlsList = document.getElementById('new-urls-list') as HTMLUListElement;
const updatedUrlsList = document.getElementById('updated-urls-list') as HTMLUListElement;
const prioritizeCrawlCheckbox = document.getElementById('prioritize-crawl-checkbox') as HTMLInputElement;
const startSitemapCrawlBtn = document.getElementById('start-sitemap-crawl-btn') as HTMLButtonElement;


const statusSection = document.getElementById('crawl-status-section') as HTMLElement;
const statusMessage = document.getElementById('crawl-status-message') as HTMLParagraphElement;

const resultsSection = document.getElementById('results-section') as HTMLElement;
const crawledUrlEl = document.getElementById('crawled-url') as HTMLParagraphElement;
const contentFullEl = document.getElementById('content-full') as HTMLPreElement;
const extractedImagesEl = document.getElementById('extracted-images') as HTMLDivElement;
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
        fullContent: { type: Type.STRING, description: "Der gesamte Haupttext des Artikels auf der Webseite, ohne Navigationsleisten, Fußzeilen oder Werbung." },
        images: {
            type: Type.ARRAY,
            description: "Ein Array der ersten 5 relevanten Bilder aus dem Artikel.",
            items: {
                type: Type.OBJECT,
                properties: {
                    src: { type: Type.STRING, description: "Die absolute URL (src) des Bildes." },
                    alt: { type: Type.STRING, description: "Der Alt-Text des Bildes." },
                },
                required: ["src", "alt"],
            }
        },
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
    required: ["fullContent", "images", "links"],
};

const SITEMAP_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        entries: {
            type: Type.ARRAY,
            description: "Eine Liste aller URL-Einträge aus der Sitemap.",
            items: {
                type: Type.OBJECT,
                properties: {
                    url: { type: Type.STRING, description: "Die URL aus dem <loc>-Tag." },
                    lastmod: { type: Type.STRING, description: "Das Datum der letzten Änderung aus dem <lastmod>-Tag im ISO 8601-Format." }
                },
                required: ["url", "lastmod"],
            }
        }
    },
    required: ["entries"],
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
    loadSitemapBtn.disabled = loading;
    const hasUrlsToCrawl = sitemapNewUrls.length > 0 || sitemapUpdatedUrls.length > 0;
    startSitemapCrawlBtn.disabled = loading || !hasUrlsToCrawl;
    urlInput.disabled = loading;
    maxPagesInput.disabled = loading;
    loader.hidden = !loading;
    crawlButtonText.textContent = message || (loading ? 'Crawle...' : 'Crawl starten');

    if (loading) errorMessage.textContent = '';
    
    if (!loading) {
        const loadSitemapBtnText = loadSitemapBtn.querySelector('.button-text');
        if (loadSitemapBtnText) loadSitemapBtnText.textContent = 'Sitemap laden & vergleichen';
    }
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
    contentFullEl.textContent = result.fullContent;

    extractedImagesEl.innerHTML = result.images.map(img =>
        `<figure>
            <img src="${img.src}" alt="${img.alt}" loading="lazy">
            <figcaption>${img.alt}</figcaption>
         </figure>`
    ).join('');

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

// --- SITEMAP LOGIC ---

async function fetchAndParseSitemap(): Promise<SitemapEntry[]> {
    try {
        const response = await ai.models.generateContent({
            model,
            contents: `Lade die Sitemap von ${SITEMAP_URL}, parse sie und extrahiere für jeden URL-Eintrag die URL aus dem <loc>-Tag und das Datum der letzten Änderung aus dem <lastmod>-Tag. Gib das Ergebnis als JSON zurück.`,
            config: {
                responseMimeType: "application/json",
                responseSchema: SITEMAP_SCHEMA,
                systemInstruction: "Du bist ein Web-Utility-Assistent. Deine Aufgabe ist es, Sitemaps abzurufen und zu parsen. Gib nur das angeforderte JSON zurück."
            }
        });

        const result = JSON.parse(response.text);
        return result.entries || [];
    } catch (error) {
        console.error("Fehler beim Abrufen und Parsen der Sitemap:", error);
        throw new Error("Konnte die Sitemap nicht von der AI verarbeiten lassen.");
    }
}

function compareSitemaps(newEntries: SitemapEntry[], oldEntries: SitemapEntry[]): { newUrls: string[], updatedUrls: string[] } {
    const oldEntriesMap = new Map(oldEntries.map(e => [e.url, e.lastmod]));
    const newUrls: string[] = [];
    const updatedUrls: string[] = [];

    for (const newEntry of newEntries) {
        if (!oldEntriesMap.has(newEntry.url)) {
            newUrls.push(newEntry.url);
        } else if (oldEntriesMap.get(newEntry.url) !== newEntry.lastmod) {
            updatedUrls.push(newEntry.url);
        }
    }
    return { newUrls, updatedUrls };
}

function renderSitemapResults() {
    sitemapResults.hidden = false;
    
    sitemapSummary.textContent = `${sitemapNewUrls.length} neue URL(s) und ${sitemapUpdatedUrls.length} aktualisierte URL(s) gefunden.`;

    const renderList = (listEl: HTMLElement, urls: string[]) => {
        if (urls.length === 0) {
            listEl.innerHTML = '<li>Keine</li>';
            return;
        }
        listEl.innerHTML = urls.map(url => `<li title="${url}">${url}</li>`).join('');
    };

    renderList(newUrlsList, sitemapNewUrls);
    renderList(updatedUrlsList, sitemapUpdatedUrls);

    const hasChanges = sitemapNewUrls.length > 0 || sitemapUpdatedUrls.length > 0;
    startSitemapCrawlBtn.disabled = !hasChanges || isLoading;
}

async function handleLoadSitemap() {
    if (isLoading) {
        alert('Ein Prozess läuft bereits. Bitte warten Sie, bis er abgeschlossen ist.');
        return;
    }
    setLoading(true);
    const btnText = loadSitemapBtn.querySelector('.button-text') as HTMLSpanElement;
    btnText.textContent = 'Lade...';
    sitemapInfo.textContent = 'Verarbeite Sitemap...';
    errorMessage.textContent = '';


    try {
        const newEntries = await fetchAndParseSitemap();
        const oldEntries: SitemapEntry[] = JSON.parse(localStorage.getItem(PREVIOUS_SITEMAP_DATA_KEY) || '[]');
        
        const { newUrls, updatedUrls } = compareSitemaps(newEntries, oldEntries);

        sitemapNewUrls = newUrls;
        sitemapUpdatedUrls = updatedUrls;
        allSitemapUrls = newEntries.map(e => e.url);

        localStorage.setItem(PREVIOUS_SITEMAP_DATA_KEY, JSON.stringify(newEntries));
        
        renderSitemapResults();

        sitemapInfo.textContent = `Sitemap zuletzt am ${new Date().toLocaleString('de-DE')} geprüft.`;

    } catch (error: any) {
        console.error("Sitemap-Prüfung fehlgeschlagen:", error);
        sitemapInfo.textContent = 'Fehler bei der Sitemap-Prüfung.';
        errorMessage.textContent = error.message || 'Ein unbekannter Fehler ist aufgetreten.';
        sitemapResults.hidden = true;
    } finally {
        setLoading(false);
    }
}

function handleStartSitemapCrawl() {
    const urlsToPrioritize = [...sitemapNewUrls, ...sitemapUpdatedUrls];
    const crawledUrls = new Set(history.map(item => item.url));
    const neverCrawledUrls = allSitemapUrls.filter(url => 
        !crawledUrls.has(url) && !urlsToPrioritize.includes(url)
    );

    const shouldPrioritize = prioritizeCrawlCheckbox.checked;

    const queue = shouldPrioritize 
        ? [...urlsToPrioritize, ...neverCrawledUrls]
        : [...neverCrawledUrls, ...urlsToPrioritize];
    
    if (queue.length === 0) {
        updateStatus('Keine neuen URLs zum Crawlen gefunden.');
        return;
    }

    startBatchCrawl(queue);
}

function startBatchCrawl(urls: string[]) {
    const sessionKeyForBatch = getSessionKey(SITEMAP_URL);
    clearSession(sessionKeyForBatch); 

    currentSession = {
        startUrl: SITEMAP_URL, // Use a generic identifier for batch crawls
        maxPages: urls.length,
        queue: urls,
        visited: [],
        batchCounter: 0,
        pagesCrawled: 0,
    };
    saveSession(currentSession);
    updateStatus(`${urls.length} URL(s) zur Warteschlange hinzugefügt. Starte Crawl...`);
    processQueue();
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
    const isSitemapCrawl = currentSession.startUrl === SITEMAP_URL;
    const startHostname = isSitemapCrawl ? null : new URL(currentSession.startUrl).hostname;

    while (currentSession.queue.length > 0 && currentSession.pagesCrawled < currentSession.maxPages) {
        if (currentSession.batchCounter >= BATCH_SIZE) {
            currentSession.batchCounter = 0;
            saveSession(currentSession);
            startCountdown(BATCH_PAUSE_MS);
            return; 
        }

        const currentUrl = currentSession.queue.shift()!;
        if (currentSession.visited.includes(currentUrl)) {
            continue;
        }

        try {
            updateStatus(`[${currentSession.pagesCrawled + 1}/${currentSession.maxPages}] Crawle Seite: ${currentUrl}...`);
            
            const response = await ai.models.generateContent({
                model,
                contents: `Analysiere die URL ${currentUrl}. Extrahiere den GESAMTEN Haupttext des Artikels (ohne Menüs, Footer oder Werbung). Extrahiere auch die URLs und Alt-Texte der ersten 5 relevanten Bilder im Artikel. Gib außerdem die 5 wichtigsten Links zurück. Gib das Ergebnis als JSON zurück.`,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: CRAWL_SCHEMA,
                    systemInstruction: "Du bist ein hilfreicher Assistent. Deine Aufgabe ist es, Webseiteninhalte zu analysieren. Alle deine Antworten und Zusammenfassungen müssen ausschließlich auf Deutsch sein, unabhängig von der Sprache der Quell-URL."
                },
            });
            const resultData = JSON.parse(response.text);

            const replacementRegex = /gohighlevel|highlevel/gi;
            const processedContent = resultData.fullContent.replace(replacementRegex, 'mightytools');
            const processedImages: CrawledImage[] = (resultData.images || []).map((img: CrawledImage) => ({
                src: img.src,
                alt: (img.alt || '').replace(replacementRegex, 'mightytools'),
            }));
            const processedLinks: CrawledLink[] = resultData.links.map((link: CrawledLink) => ({
                text: link.text.replace(replacementRegex, 'mightytools'),
                url: link.url,
            }));

            const newResult: CrawlResult = {
                id: Date.now(),
                url: currentUrl,
                fullContent: processedContent,
                images: processedImages,
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

            if (startHostname) {
                 processedLinks.forEach(link => {
                    try {
                        const absoluteUrl = new URL(link.url, currentUrl).href;
                        if (new URL(absoluteUrl).hostname === startHostname && !currentSession.visited.includes(absoluteUrl) && !currentSession.queue.includes(absoluteUrl)) {
                            currentSession.queue.push(absoluteUrl);
                        }
                    } catch (e) { /* ignore invalid URLs */ }
                });
            }

            saveSession(currentSession);
            
            updateStatus(`Warte ${REQUEST_DELAY_MS / 1000}s, um Ratenbegrenzung zu vermeiden...`);
            await sleep(REQUEST_DELAY_MS);

        } catch (error: any) {
            console.error("Crawl fehlgeschlagen:", error);
            const errorMessageText = error.message.includes('429') 
                ? 'API-Ratenlimit erreicht. Der Prozess wird pausiert. Bitte versuchen Sie es später erneut.' 
                : 'Das Crawlen der URL ist fehlgeschlagen. Seite übersprungen.';
            errorMessage.textContent = errorMessageText;
            currentSession.visited.push(currentUrl);
            saveSession(currentSession);
            await sleep(5000); 
        }
    }

    if(currentSession) {
        updateStatus(`Crawl abgeschlossen. ${currentSession.pagesCrawled} Seiten verarbeitet.`);
        clearSession(currentSession.startUrl);
        currentSession = null;
    }
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
    } else {
        currentSession.maxPages = maxPages;
        saveSession(currentSession);
    }
    
    processQueue();
}

// --- EVENT LISTENERS ---
function setupEventListeners() {
    crawlForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = urlInput.value.trim();
        const maxPages = parseInt(maxPagesInput.value, 10);
        if (!url || isLoading || !maxPages || maxPages < 1) {
            errorMessage.textContent = 'Bitte geben Sie eine gültige URL und eine maximale Seitenanzahl an.';
            return;
        }
        errorMessage.textContent = '';

        const session = loadSession(url);
        if (session && session.queue.length > 0 && session.pagesCrawled < session.maxPages) {
            resumeModal.hidden = false;
        } else {
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

    loadSitemapBtn.addEventListener('click', handleLoadSitemap);
    startSitemapCrawlBtn.addEventListener('click', handleStartSitemapCrawl);
}

// --- INITIALIZATION ---
function init() {
    loadHistory();
    setupEventListeners();
}

init();