import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Konfigürasyon
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.WOLVOKS_API_KEY || 'wolvoks_admin_key_12345';

// Yetkili kullanıcılar
const AUTHORIZED_USERS = process.env.AUTHORIZED_TELEGRAM_USERS?.split(',').map(id => parseInt(id.trim())) || [];

// Google AI'yi başlat
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Telegram Bot'u başlat
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Sohbet geçmişi (kullanıcı bazında)
const chatHistory: { [userId: number]: any[] } = {};

// Lisans yönetimi
interface UserLicense {
  userId: number;
  username?: string;
  firstName?: string;
  isActive: boolean;
  permissions: string[];
  createdAt: Date;
  lastUsed?: Date;
  usageCount: number;
}

// Kullanıcı lisansları (gerçek uygulamada veritabanında tutulmalı)
const userLicenses: { [userId: number]: UserLicense } = {};

// Admin kullanıcıları
const ADMIN_USERS = process.env.ADMIN_TELEGRAM_USERS?.split(',').map(id => parseInt(id.trim())) || [6828100139];

// Mevcut izinler ve açıklamaları
const AVAILABLE_PERMISSIONS = {
  'getBankBalances': '💰 Banka Bakiyeleri',
  'getGeneralBalanceTotal': '📊 Bakiyeler Listesi Genel Toplam',
  'getReceivableBalanceList': '🟢 Alacaklı Bakiye Listesi',
  'getDebtorBalanceList': '🔴 Borçlu Bakiye Listesi',
  'getStockReport': '📦 Stok Raporu',
  'getCustomerInfo': '👥 Cari Hesap Bilgileri',
  'getCreditCardLimits': '💳 Kredi Kartı Limitleri',
  'getForeignCurrencyAccounts': '💱 Döviz Hesapları TL Karşılığı',
  'getOwnChecks': '📄 Kendi Çeklerimiz',
  'getCashBalance': '💵 Kasa Bakiye Detayı',
  'getQuoteReport': '📋 Teklif Raporu',
  'getQuoteDetail': '📋 Teklif Detayı',
  'getCustomerMovement': '📈 Cari Hareket Raporu',
  'getBalanceList': '📊 Parametreli Bakiyeler Listesi',
  'testConnection': '🔧 Sistem Testi',
  'generatePDF': '📄 PDF Oluşturma',
  'getAdvancedAnalytics': '📊 Gelişmiş Analitik',
  'getFinancialInsights': '💡 Finansal Öngörüler'
};

const ALL_PERMISSIONS = Object.keys(AVAILABLE_PERMISSIONS);

// İstatistikler
interface BotStats {
  totalUsers: number;
  activeUsers: number;
  totalQueries: number;
  queriesByType: { [key: string]: number };
  dailyUsage: { [date: string]: number };
}

const botStats: BotStats = {
  totalUsers: 0,
  activeUsers: 0,
  totalQueries: 0,
  queriesByType: {},
  dailyUsage: {}
};

// MCP Sunucusu Konfigürasyonu (SQL bağlantısı artık gerekli değil)
// Tüm veritabanı işlemleri MCP sunucusu üzerinden yapılıyor

// Kullanıcı yetki kontrolü
function isAuthorized(userId: number): boolean {
  return AUTHORIZED_USERS.length === 0 || AUTHORIZED_USERS.includes(userId);
}

// ERP API fonksiyonları
const getBankBalancesFunction: FunctionDeclaration = {
  name: "getBankBalances",
  description: "Banka hesaplarının bakiye durumlarını getirir. Kullanıcı banka bakiyesi, para durumu, hesap bakiyesi sorduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      bankName: {
        type: Type.STRING,
        description: "Filtrelemek için banka adı (opsiyonel). Örn: 'garanti', 'ziraat', 'akbank'"
      },
      para_birimi: {
        type: Type.STRING,
        description: "Filtrelemek için para birimi (opsiyonel). Örn: 'TL', 'USD', 'EUR'"
      }
    },
    required: []
  }
};

const getStockReportFunction: FunctionDeclaration = {
  name: "getStockReport",
  description: "Stok durumlarını getirir. Kullanıcı stok, ürün, malzeme, envanter sorduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      productName: {
        type: Type.STRING,
        description: 'Aranacak ürün adı (opsiyonel)'
      },
      depo_adi: {
        type: Type.STRING,
        description: 'Filtrelemek için depo adı (opsiyonel)'
      }
    },
    required: []
  }
};

const testConnectionFunction: FunctionDeclaration = {
  name: "testConnection",
  description: "Sistem bağlantısını test eder. Kullanıcı sistem durumu, bağlantı testi sorduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const generatePDFFunction: FunctionDeclaration = {
  name: 'generatePDF',
  description: 'Belirtilen veri için profesyonel PDF raporu oluşturur',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reportType: {
        type: Type.STRING,
        description: 'Rapor türü: bankBalances (banka bakiyeleri) veya stockReport (stok raporu)',
        enum: ['bankBalances', 'stockReport']
      },
      title: {
        type: Type.STRING,
        description: 'PDF rapor başlığı'
      }
    },
    required: ['reportType']
  }
};

// Yeni fonksiyonlar
const getCustomerInfoFunction: FunctionDeclaration = {
  name: "getCustomerInfo",
  description: "Cari hesap bilgilerini ve bakiyelerini getirir. Müşteri bilgileri, cari hesap durumu sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      customerName: {
        type: Type.STRING,
        description: 'Aranacak cari ünvanı (opsiyonel)'
      }
    },
    required: []
  }
};

const getCreditCardLimitsFunction: FunctionDeclaration = {
  name: "getCreditCardLimits",
  description: "Kredi kartı limit ve kullanılabilir bakiye raporunu getirir. Kredi kartı durumu sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const getForeignCurrencyAccountsFunction: FunctionDeclaration = {
  name: "getForeignCurrencyAccounts",
  description: "Döviz hesaplarının güncel kurdan TL karşılığını getirir. Döviz durumu, USD, EUR hesapları sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const getOwnChecksFunction: FunctionDeclaration = {
  name: "getOwnChecks",
  description: "Kendi çek ve senetlerimizin özet raporunu getirir. Çek durumu, senet durumu sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      reportType: {
        type: Type.STRING,
        description: "Rapor türü: 'ozet' (özet) veya 'detay' (detaylı)",
        enum: ['ozet', 'detay']
      }
    },
    required: []
  }
};



const getCashBalanceFunction: FunctionDeclaration = {
  name: "getCashBalance",
  description: "Kasa bakiyelerinin detaylı raporunu getirir. Kasa durumu, nakit durumu sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const getQuoteReportFunction: FunctionDeclaration = {
  name: "getQuoteReport",
  description: "Teklif raporunu getirir. Teklif durumu, müşteri teklifleri sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      customerName: {
        type: Type.STRING,
        description: "Aranacak cari ünvanı (opsiyonel)"
      },
      quoteStatus: {
        type: Type.STRING,
        description: "Teklif durumu kodu (opsiyonel)"
      }
    },
    required: []
  }
};

const getQuoteDetailFunction: FunctionDeclaration = {
  name: "getQuoteDetail",
  description: "Belirli bir teklif numarasının detaylarını getirir. 'X teklifini aç', 'teklif detayı' sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      quoteNumber: {
        type: Type.STRING,
        description: "Teklif numarası (örn: TEK-2023-1050, MTK13777)"
      }
    },
    required: ["quoteNumber"]
  }
};

const getCustomerMovementFunction: FunctionDeclaration = {
  name: "getCustomerMovement",
  description: "Cari hesap hareket raporunu getirir. Müşteri hareketleri, hesap hareketleri sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      customerName: {
        type: Type.STRING,
        description: "Aranacak cari ünvanı (zorunlu)"
      },
      startDate: {
        type: Type.STRING,
        description: "Başlangıç tarihi (YYYY-MM-DD formatında, opsiyonel)"
      },
      endDate: {
        type: Type.STRING,
        description: "Bitiş tarihi (YYYY-MM-DD formatında, opsiyonel)"
      }
    },
    required: ['customerName']
  }
};

const getAdvancedAnalyticsFunction: FunctionDeclaration = {
  name: "getAdvancedAnalytics",
  description: "Gelişmiş analitik ve öngörüler sunar. Trend analizi, karşılaştırma, öngörü istendiğinde kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      analysisType: {
        type: Type.STRING,
        description: "Analiz türü: 'financial' (finansal), 'inventory' (stok), 'customer' (müşteri)",
        enum: ['financial', 'inventory', 'customer']
      }
    },
    required: ['analysisType']
  }
};

const getFinancialInsightsFunction: FunctionDeclaration = {
  name: "getFinancialInsights",
  description: "Finansal öngörüler ve stratejik öneriler sunar. Mali durum analizi, öneriler istendiğinde kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

// PDF talep fonksiyonu tanımı
const handlePDFRequestFunction: FunctionDeclaration = {
  name: "handlePDFRequest",
  description: "Son sorgu sonucunu PDF olarak oluştur ve gönder",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

// Yeni bakiye listesi fonksiyonları (guncelleme.txt'den doğru olanlar)
const getGeneralBalanceTotalFunction: FunctionDeclaration = {
  name: "getGeneralBalanceTotal",
  description: "Bakiyeler listesi genel toplam verisi",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const getDebtorBalanceListFunction: FunctionDeclaration = {
  name: "getDebtorBalanceList",
  description: "Bakiyeler listesi müşteri grubu borçlu",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const getReceivableBalanceListFunction: FunctionDeclaration = {
  name: "getReceivableBalanceList",
  description: "Bakiyeler listesi müşteri grubu alacaklı",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

// Yeni eklenen fonksiyonlar - MCP sunucusundaki eksik sorgular

const getBalanceListFunction: FunctionDeclaration = {
  name: "getBalanceList",
  description: "Parametreli bakiyeler listesi - grup, ticari ünvan ve bakiye durumu filtreleme. Bakiye listesi, müşteri bakiyeleri, borçlu/alacaklı listesi sorulduğunda kullan.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      groupFilter: {
        type: Type.STRING,
        description: "Grup filtresi (opsiyonel) - örn: '1 - MÜŞTERİ', '2 - TEDARİKÇİ'"
      },
      companyNameFilter: {
        type: Type.STRING,
        description: "Ticari ünvan filtresi (opsiyonel) - kısmi arama"
      },
      balanceStatusFilter: {
        type: Type.STRING,
        description: "Bakiye durumu filtresi (opsiyonel) - 'borclu', 'alacakli', 'sifir'"
      }
    },
    required: []
  }
};

const erpFunctions = [
  getBankBalancesFunction,
  getGeneralBalanceTotalFunction,
  getReceivableBalanceListFunction,
  getDebtorBalanceListFunction,
  getStockReportFunction,
  testConnectionFunction,
  generatePDFFunction,
  getCustomerInfoFunction,
  getCreditCardLimitsFunction,
  getForeignCurrencyAccountsFunction,
  getOwnChecksFunction,
  getCashBalanceFunction,
  getQuoteReportFunction,
  getQuoteDetailFunction,
  getCustomerMovementFunction,
  getBalanceListFunction,
  getAdvancedAnalyticsFunction,
  getFinancialInsightsFunction,
  handlePDFRequestFunction
];

// Türkçe karakter normalleştirme fonksiyonu
function normalizeTurkish(text: string): string {
  if (!text) return '';

  return text
    .toLowerCase()
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/İ/g, 'i')
    .replace(/Ğ/g, 'g')
    .replace(/Ü/g, 'u')
    .replace(/Ş/g, 's')
    .replace(/Ö/g, 'o')
    .replace(/Ç/g, 'c')
    // Unicode normalizasyonu
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Lisans yönetim fonksiyonları
function hasLicense(userId: number): boolean {
  return userLicenses[userId] && userLicenses[userId].isActive;
}

function hasPermission(userId: number, permission: string): boolean {
  const license = userLicenses[userId];
  return license && license.isActive && license.permissions.includes(permission);
}

function isAdmin(userId: number): boolean {
  return ADMIN_USERS.includes(userId);
}

function createLicense(userId: number, username?: string, firstName?: string, permissions: string[] = ALL_PERMISSIONS): void {
  userLicenses[userId] = {
    userId,
    username,
    firstName,
    isActive: true,
    permissions,
    createdAt: new Date(),
    usageCount: 0
  };
  botStats.totalUsers++;
}

function updateUsageStats(userId: number, functionName: string): void {
  if (userLicenses[userId]) {
    userLicenses[userId].lastUsed = new Date();
    userLicenses[userId].usageCount++;
  }

  botStats.totalQueries++;
  botStats.queriesByType[functionName] = (botStats.queriesByType[functionName] || 0) + 1;

  const today = new Date().toISOString().split('T')[0];
  botStats.dailyUsage[today] = (botStats.dailyUsage[today] || 0) + 1;
}

// Admin komutları artık bot.onText ile handle ediliyor

function getAdminPanel(): string {
  return `*🔧 TAR-S ERP ZEK Admin Panel*

*📊 Hızlı İstatistikler:*
• Toplam Kullanıcı: \`${botStats.totalUsers}\`
• Aktif Kullanıcı: \`${Object.values(userLicenses).filter(l => l.isActive).length}\`
• Toplam Sorgu: \`${botStats.totalQueries}\`

*� Kullanıcı Yönetimi:*
\`/users\` - Kullanıcı listesi
\`/adduser <id> [izinler]\` - Kullanıcı ekle
\`/removeuser <id>\` - Kullanıcı kaldır
\`/manageperm <id>\` - İzin yönetimi (Önerilen)

*� İzin Yönetimi:*
\`/permissions\` - İzin listesi ve komutlar
\`/userperm <id>\` - Kullanıcı izinlerini göster
\`/grantall <id>\` - Tüm izinleri ver
\`/revokeall <id>\` - Tüm izinleri kaldır

*📊 İstatistikler:*
\`/stats\` - Detaylı sistem istatistikleri

*💡 Hızlı Başlangıç:*
1. \`/users\` - Kullanıcıları listele
2. \`/manageperm <user_id>\` - İzinleri yönet`;
}

function getStatistics(): string {
  const activeUsers = Object.values(userLicenses).filter(l => l.isActive).length;
  const today = new Date().toISOString().split('T')[0];
  const todayUsage = botStats.dailyUsage[today] || 0;

  let message = `*📊 TAR-S ERP ZEK İstatistikleri*

*👥 Kullanıcı İstatistikleri:*
• Toplam Kullanıcı: \`${botStats.totalUsers}\`
• Aktif Kullanıcı: \`${activeUsers}\`
• Bugünkü Kullanım: \`${todayUsage}\`

*📈 Sorgu İstatistikleri:*
• Toplam Sorgu: \`${botStats.totalQueries}\`\n`;

  Object.keys(botStats.queriesByType).forEach(type => {
    message += `• ${type}: \`${botStats.queriesByType[type]}\`\n`;
  });

  return message;
}

function getUserList(): string {
  const users = Object.values(userLicenses);
  if (users.length === 0) {
    return '❌ Henüz kullanıcı yok.';
  }

  let message = `*👥 Kullanıcı Listesi (${users.length})*\n\n`;

  users.forEach(user => {
    const status = user.isActive ? '✅' : '❌';
    const lastUsed = user.lastUsed ? user.lastUsed.toLocaleDateString('tr-TR') : 'Hiç';
    message += `${status} \`${user.userId}\` - ${user.firstName || 'N/A'}\n`;
    message += `   Son Kullanım: ${lastUsed}\n`;
    message += `   Kullanım: ${user.usageCount} kez\n\n`;
  });

  return message;
}

// MCP Sunucusu Konfigürasyonu
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000';

// MCP Sunucusu ile Gerçek Entegrasyon

// MCP Sorgu çalıştırma - Gerçek MCP sunucusunu kullan
async function executeMCPQuery(queryName: string, parameters: any = {}): Promise<any> {
  try {
    console.log(`🔗 MCP Sunucusuna sorgu gönderiliyor: ${queryName}`, parameters);

    const response = await fetch(`${MCP_SERVER_URL}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        query: queryName,
        parameters: parameters
      })
    });

    if (!response.ok) {
      throw new Error(`MCP Sunucu hatası: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    console.log(`✅ MCP Sunucusundan cevap alındı: ${(result as any).recordCount} kayıt`);

    return {
      success: true,
      query: queryName,
      recordCount: (result as any).recordCount || 0,
      data: (result as any).data || [],
      executedAt: new Date().toISOString(),
      mcpResponse: true // MCP sunucusundan geldiğini belirt
    };

  } catch (error) {
    console.error(`❌ MCP Sunucu bağlantı hatası - ${queryName}:`, error);

    return {
      success: false,
      error: `MCP Sunucu bağlantı hatası: ${error}`,
      query: queryName,
      executedAt: new Date().toISOString()
    };
  }
}

// Artık sadece MCP sunucusu kullanılıyor - Fallback kaldırıldı

// Sayı formatlaması (Türkçe format: 150.000,00)
function formatNumber(num: number): string {
  if (isNaN(num) || !isFinite(num)) return '0,00';

  return num.toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Türkçe sayı formatını parse et (3.649.961,09 -> 3649961.09)
function parseTurkishNumber(value: any): number {
  if (typeof value === 'number') return value;
  if (!value || value === '-' || value === '' || value === null || value === undefined) return 0;

  const str = String(value);
  // Türkçe format: 3.649.961,09 -> 3649961.09
  const cleaned = str
    .replace(/\./g, '') // Binlik ayırıcı noktaları kaldır
    .replace(',', '.'); // Virgülü noktaya çevir

  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

// Para birimi emoji'si
function getCurrencyEmoji(currency: string): string {
  const emojis: { [key: string]: string } = {
    'TL': '💵',
    'USD': '💵',
    'EUR': '💶',
    'GBP': '💷'
  };
  return emojis[currency.toUpperCase()] || '💰';
}

// Akıllı teklif arama fonksiyonu
async function findMatchingQuotes(searchTerm: string): Promise<{ exact: any[], similar: any[], suggestions: string[] }> {
  try {
    // Tüm teklif bilgilerini al
    const quoteResult = await executeMCPQuery('teklif_raporu');

    if (!quoteResult.success || !quoteResult.data) {
      return { exact: [], similar: [], suggestions: [] };
    }

    const quotes = quoteResult.data;
    const searchLower = searchTerm.toLowerCase().trim();

    // Tam eşleşme (teklif numarası)
    const exactMatches = quotes.filter((quote: any) => {
      const quoteNo = (quote['TeklifNo'] || '').toLowerCase();
      return quoteNo === searchLower || quoteNo.includes(searchLower);
    });

    // Benzer eşleşmeler (müşteri adı, açıklama)
    const similarMatches = quotes.filter((quote: any) => {
      const quoteNo = (quote['TeklifNo'] || '').toLowerCase();
      const customerName = (quote['CariUnvan'] || '').toLowerCase();
      const description = (quote['TeklifAciklamasi'] || '').toLowerCase();

      if (!exactMatches.some(exact => exact['TeklifNo'] === quote['TeklifNo'])) {
        return (
          quoteNo.includes(searchLower) ||
          customerName.includes(searchLower) ||
          description.includes(searchLower) ||
          searchLower.split(' ').some((word: string) =>
            word.length > 2 && (quoteNo.includes(word) || customerName.includes(word))
          )
        );
      }
      return false;
    });

    // Öneriler oluştur
    const suggestions = [...exactMatches, ...similarMatches]
      .slice(0, 5)
      .map((quote: any) => `${quote['TeklifNo']} - ${quote['CariUnvan']}`)
      .filter((suggestion: string) => suggestion !== ' - ');

    return {
      exact: exactMatches,
      similar: similarMatches,
      suggestions: suggestions
    };

  } catch (error) {
    console.error('Teklif arama hatası:', error);
    return { exact: [], similar: [], suggestions: [] };
  }
}

// Akıllı cari arama ve eşleştirme fonksiyonu
async function findMatchingCustomers(searchTerm: string): Promise<{ exact: any[], similar: any[], suggestions: string[] }> {
  try {
    // Tüm cari bilgilerini al
    const customerResult = await executeMCPQuery('cari_bilgi');

    if (!customerResult.success || !customerResult.data) {
      return { exact: [], similar: [], suggestions: [] };
    }

    const customers = customerResult.data;
    const searchNormalized = normalizeTurkish(searchTerm);

    // Tam eşleşme
    const exactMatches = customers.filter((customer: any) => {
      const customerName = normalizeTurkish(customer['CariUnvan'] || '');
      return customerName === searchNormalized;
    });

    // Benzer eşleşmeler (içerir, başlar, kelime eşleşmesi)
    const similarMatches = customers.filter((customer: any) => {
      const customerName = normalizeTurkish(customer['CariUnvan'] || '');

      // Tam eşleşme değilse ve benzerlik varsa
      if (customerName !== searchNormalized) {
        return (
          customerName.includes(searchNormalized) ||
          searchNormalized.includes(customerName) ||
          customerName.startsWith(searchNormalized) ||
          searchNormalized.startsWith(customerName) ||
          // Kelime bazında eşleşme
          searchNormalized.split(' ').some(word =>
            word.length > 2 && customerName.includes(word)
          ) ||
          customerName.split(' ').some(word =>
            word.length > 2 && searchNormalized.includes(word)
          )
        );
      }
      return false;
    });

    // Öneriler oluştur (en benzer 5 tane)
    const suggestions = similarMatches
      .slice(0, 5)
      .map((customer: any) => customer['CariUnvan'] || 'Bilinmeyen')
      .filter((name: string) => name !== 'Bilinmeyen');

    return {
      exact: exactMatches,
      similar: similarMatches,
      suggestions: suggestions
    };

  } catch (error) {
    console.error('Cari arama hatası:', error);
    return { exact: [], similar: [], suggestions: [] };
  }
}

// Telegram inline keyboard oluşturma
function createCustomerSelectionKeyboard(customers: string[], originalQuery: string): any {
  const keyboard = customers.map((customer, index) => [{
    text: `${index + 1}. ${customer}`,
    callback_data: `select_customer:${customer}:${originalQuery}`
  }]);

  // İptal butonu ekle
  keyboard.push([{
    text: '❌ İptal',
    callback_data: 'cancel_selection'
  }]);

  return {
    reply_markup: {
      inline_keyboard: keyboard
    }
  };
}

// PDF talep etme fonksiyonu
async function handlePDFRequest(userId: number): Promise<string> {
  try {
    const userPref = userPreferences[userId];

    if (!userPref || !userPref.lastData || userPref.lastData.length === 0) {
      return '❌ **PDF oluşturulamadı.**\n\n💡 **Önce bir sorgu yapın** (örn: "banka bakiyelerim"), sonra "PDF olarak at" deyin.';
    }

    // PDF oluştur
    const pdfPath = await generatePDF(userPref.lastData, userPref.lastDataType, userPref.lastTitle);

    // PDF'i Telegram'da gönder
    try {
      await bot.sendDocument(userId, pdfPath, {
        caption: `📄 **${userPref.lastTitle}**\n\n✅ ${userPref.lastData.length} kayıt\n📅 ${new Date().toLocaleDateString('tr-TR')}`
      }, {
        contentType: 'application/pdf',
        filename: `${userPref.lastTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`
      });

      // Dosyayı sil (güvenlik için)
      setTimeout(() => {
        if (fs.existsSync(pdfPath)) {
          fs.unlinkSync(pdfPath);
        }
      }, 5000);

      return `✅ **PDF raporu başarıyla gönderildi!** 📄\n\n📊 **İçerik:** ${userPref.lastTitle}\n📈 **Kayıt Sayısı:** ${userPref.lastData.length}`;
    } catch (telegramError) {
      console.error('Telegram PDF gönderme hatası:', telegramError);
      return `✅ PDF oluşturuldu ancak gönderilirken hata oluştu.\n\n📁 **Dosya yolu:** ${pdfPath}`;
    }

  } catch (error) {
    console.error('PDF oluşturma hatası:', error);
    return `❌ **PDF oluşturulamadı:** ${error}`;
  }
}

// Kullanıcı tercih durumu (PDF mi metin mi)
const userPreferences: { [userId: string]: { preferText: boolean, lastDataType: string, lastData: any[], lastQuery: string, lastTitle: string } } = {};

// Bekleyen cari seçimleri
const pendingCustomerSelections: { [userId: string]: { query: string, searchTerm: string, suggestions: string[] } } = {};

// Akıllı özet sistemi - Veri büyüklüğünü kontrol et
function shouldCreateSummary(data: any[], dataType: string, userId?: string): { shouldSummarize: boolean, summary: string, shouldCreatePDF: boolean } {
  const dataLength = data.length;
  const estimatedMessageLength = dataLength * 100; // Ortalama karakter tahmini

  // Kullanıcı tercihi kontrolü
  const userPref = userId ? userPreferences[userId] : null;
  const forceText = userPref?.preferText && userPref?.lastDataType === dataType;

  if (dataLength > 10 || estimatedMessageLength > 1000) {
    let summary = '';
    let shouldCreatePDF = !forceText; // Kullanıcı metin isterse PDF oluşturma

    if (dataType === 'bankBalances') {
      // Banka bakiyeleri için özet
      const bankCount = new Set(data.map(row => row['Banka Adı'])).size;
      const currencies = new Set(data.map(row => row['Para Birimi'])).size;
      const totalBalance = calculateTotalBalance(data);

      summary = `💰 **Banka Bakiye Özeti**\n\n`;
      summary += `📊 **Toplam:** ${dataLength} hesap, ${bankCount} banka, ${currencies} para birimi\n`;
      summary += `💵 **Genel Bakiye:** ${totalBalance}\n\n`;

      if (forceText) {
        summary += `📝 **Metin formatında detaylar aşağıda...**`;
      } else {
        summary += `📄 **Detaylı rapor PDF olarak gönderiliyor...**\n`;
        summary += `💬 _"PDF atma metin olarak ilet" diyerek metin formatını tercih edebilirsiniz._`;
      }

    } else if (dataType === 'stockReport') {
      // Stok raporu için özet
      const totalItems = data.length;
      const totalQuantity = data.reduce((sum, row) => sum + (parseFloat(row['MIKTAR'] || row['miktar']) || 0), 0);

      summary = `📦 **Stok Durumu Özeti**\n\n`;
      summary += `📊 **Toplam:** ${totalItems} ürün\n`;
      summary += `📈 **Toplam Miktar:** ${formatNumber(totalQuantity)}\n\n`;

      if (forceText) {
        summary += `📝 **Metin formatında detaylar aşağıda...**`;
      } else {
        summary += `📄 **Detaylı rapor PDF olarak gönderiliyor...**\n`;
        summary += `💬 _"PDF atma metin olarak ilet" diyerek metin formatını tercih edebilirsiniz._`;
      }
    }

    return { shouldSummarize: true, summary, shouldCreatePDF };
  }

  return { shouldSummarize: false, summary: '', shouldCreatePDF: false };
}

// Toplam bakiye hesaplama fonksiyonu
function calculateTotalBalance(data: any[]): string {
  let totals: { [currency: string]: number } = {};

  data.forEach(row => {
    const currency = row['Para Birimi'];
    const balance = parseFloat(row['Bakiye']) || 0;

    if (currency && !row['Banka Adı']?.includes('TOPLAM')) {
      totals[currency] = (totals[currency] || 0) + balance;
    }
  });

  return Object.keys(totals)
    .map(currency => `${formatNumber(totals[currency])} ${currency}`)
    .join(', ');
}

// Banka bakiyelerini güzel formatta sun (Telegram için)
function formatBankBalances(data: any[], userId?: string, forceFullText: boolean = false): string {
  if (!data || data.length === 0) {
    return '❌ Maalesef banka bakiyesi bulunamadı.';
  }

  // Akıllı özet kontrolü
  const summaryCheck = shouldCreateSummary(data, 'bankBalances', userId);
  if (summaryCheck.shouldSummarize && !forceFullText) {
    return summaryCheck.summary;
  }

  let message = '💰 **Banka Bakiyeleriniz**\n\n';
  let totalsByBank: { [key: string]: { [key: string]: number } } = {};

  // Önce verileri grupla
  data.forEach(row => {
    const bankName = row['Banka Adı'];
    const currency = row['Para Birimi'];
    const balance = parseFloat(row['Bakiye']) || 0;

    if (!bankName.includes('TOPLAM') && currency && balance !== 0) {
      if (!totalsByBank[bankName]) {
        totalsByBank[bankName] = {};
      }
      totalsByBank[bankName][currency] = (totalsByBank[bankName][currency] || 0) + balance;
    }
  });

  // Tam metin formatı mı yoksa özet mi?
  const bankNames = forceFullText ? Object.keys(totalsByBank) : Object.keys(totalsByBank).slice(0, 5);

  bankNames.forEach(bankName => {
    message += `🏦 **${bankName}**\n`;

    Object.keys(totalsByBank[bankName]).forEach(currency => {
      const total = totalsByBank[bankName][currency];
      message += `   ${getCurrencyEmoji(currency)} ${formatNumber(total)} ${currency}\n`;
    });

    message += '\n';
  });

  // Genel toplam
  let grandTotals: { [key: string]: number } = {};
  Object.values(totalsByBank).forEach(bankTotals => {
    Object.keys(bankTotals).forEach(currency => {
      grandTotals[currency] = (grandTotals[currency] || 0) + bankTotals[currency];
    });
  });

  if (Object.keys(grandTotals).length > 0) {
    message += '📊 **Genel Toplam**\n';
    Object.keys(grandTotals).forEach(currency => {
      message += `   ${getCurrencyEmoji(currency)} **${formatNumber(grandTotals[currency])} ${currency}**\n`;
    });
  }

  if (!forceFullText && Object.keys(totalsByBank).length > 5) {
    message += `\n_... ve ${Object.keys(totalsByBank).length - 5} banka daha_\n`;
    message += `💬 _"PDF atma metin olarak ilet" diyerek tüm detayları görebilirsiniz._`;
  }

  return message;
}

// Stok raporunu güzel formatta sun (Telegram için)
function formatStockReport(data: any[], userId?: string, forceFullText: boolean = false): string {
  if (!data || data.length === 0) {
    return '❌ Stok verisi bulunamadı.';
  }

  // Akıllı özet kontrolü
  const summaryCheck = shouldCreateSummary(data, 'stockReport', userId);
  if (summaryCheck.shouldSummarize && !forceFullText) {
    return summaryCheck.summary;
  }

  let message = '📦 **Stok Durumunuz**\n\n';

  // Tam metin formatı mı yoksa özet mi?
  const itemsToShow = forceFullText ? data : data.slice(0, 12);

  // Stok verilerini ürün bazında grupla
  const groupedStock: { [key: string]: any[] } = {};

  itemsToShow.forEach((row) => {
    const stockCode = row['STOK_KODU'] || row['Stok Kodu'] || 'N/A';
    const stockName = row['STOK_ADI'] || row['Stok Adı'] || 'N/A';
    const depot = row['DEPO_ADI'] || row['Depo Adı'] || 'Bilinmeyen Depo';
    const quantity = parseFloat(row['MIKTAR'] || row['Anlık Miktar'] || 0);

    const key = `${stockCode}|${stockName}`;
    if (!groupedStock[key]) {
      groupedStock[key] = [];
    }
    groupedStock[key].push({ depot, quantity });
  });

  let index = 1;
  Object.keys(groupedStock).forEach((key) => {
    const [stockCode, stockName] = key.split('|');
    const depots = groupedStock[key];

    message += `**${index}.** ${stockName}\n`;
    message += `   📋 **Kod:** \`${stockCode}\`\n`;

    // Depo bazında miktarları göster
    let totalQuantity = 0;
    depots.forEach((depot) => {
      if (depot.quantity > 0) {
        message += `   🏪 **${depot.depot}:** ${formatNumber(depot.quantity)} adet\n`;
        totalQuantity += depot.quantity;
      }
    });

    message += `   📊 **Toplam:** ${formatNumber(totalQuantity)} adet\n\n`;
    index++;
  });

  if (!forceFullText && data.length > 12) {
    message += `_... ve ${data.length - 12} ürün daha var_\n\n`;
    message += `💬 _"PDF atma metin olarak ilet" diyerek tüm detayları görebilirsiniz._`;
  }

  return message;
}

// Cari hesap bilgilerini güzel formatta sun (Telegram için)
function formatCustomerInfo(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Cari hesap bilgisi bulunamadı.';
  }

  let message = '👥 **Cari Hesap Bilgileri**\n\n';

  data.slice(0, 10).forEach((row, index) => {
    const customerName = row['CariUnvan'] || 'N/A';
    const currency = row['ParaBirimi'] || 'TL';
    const totalDebt = parseFloat(row['ToplamBorc']) || 0;
    const totalCredit = parseFloat(row['ToplamAlacak']) || 0;
    const balance = parseFloat(row['Bakiye']) || 0;

    message += `**${index + 1}.** ${customerName}\n`;
    message += `   💰 Para Birimi: ${currency}\n`;
    message += `   📈 Toplam Borç: ${formatNumber(totalDebt)} ${currency}\n`;
    message += `   📉 Toplam Alacak: ${formatNumber(totalCredit)} ${currency}\n`;
    message += `   💵 Bakiye: ${formatNumber(balance)} ${currency}\n\n`;
  });

  if (data.length > 10) {
    message += `_... ve ${data.length - 10} cari daha var_\n\n`;
    message += `💬 _"PDF atma metin olarak ilet" diyerek tüm detayları görebilirsiniz._`;
  }

  return message;
}

// Kredi kartı limitlerini güzel formatta sun (Telegram için)
function formatCreditCardLimits(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Kredi kartı limit bilgisi bulunamadı.';
  }

  let message = '💳 **Kredi Kartı Limit Durumu**\n\n';

  data.forEach((row) => {
    const bankName = row['TANIM'] || 'N/A';
    const totalLimit = parseFloat(row['KK TOP LİMİTLER']) || 0;
    const availableLimit = parseFloat(row['KK KULLANILABİLİR LİMİTLER']) || 0;
    const usedLimit = totalLimit - availableLimit;
    const usagePercentage = totalLimit > 0 ? ((usedLimit / totalLimit) * 100).toFixed(1) : '0.0';

    if (bankName === 'TOPLAM :') {
      message += `📊 **${bankName}**\n`;
      message += `   💳 Toplam Limit: **${formatNumber(totalLimit)} TL**\n`;
      message += `   ✅ Kullanılabilir: **${formatNumber(availableLimit)} TL**\n`;
      message += `   📈 Kullanılan: **${formatNumber(usedLimit)} TL** (${usagePercentage}%)\n\n`;
    } else {
      message += `🏦 **${bankName}**\n`;
      message += `   💳 Limit: ${formatNumber(totalLimit)} TL\n`;
      message += `   ✅ Kullanılabilir: ${formatNumber(availableLimit)} TL\n`;
      message += `   📈 Kullanılan: ${formatNumber(usedLimit)} TL (${usagePercentage}%)\n\n`;
    }
  });

  return message;
}

// Döviz hesaplarını güzel formatta sun
function formatForeignCurrencyAccounts(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Döviz hesabı bilgisi bulunamadı.';
  }

  let message = '💱 **Döviz Hesapları TL Karşılığı**\n\n';

  data.forEach((row) => {
    const bankName = row['BankaAdi'] || 'N/A';
    const accountNo = row['HesapNo'] || 'N/A';
    const accountName = row['HesapTanimi'] || 'N/A';
    const currency = row['ParaBirimi'] || 'N/A';
    const foreignBalance = parseFloat(row['BakiyeDoviz_Gosterilecek']) || 0;
    const currentRate = parseFloat(row['GuncelKur']) || 0;
    const tlEquivalent = parseFloat(row['BakiyeTL_Karsiligi_Gosterilecek']) || 0;
    const status = row['Durum'] || 'N/A';

    if (bankName.includes('TOPLAM')) {
      message += `📊 **${bankName}**\n`;
      message += `   💰 **${formatNumber(tlEquivalent)} TL**\n\n`;
    } else {
      message += `🏦 **${bankName}**\n`;
      message += `   📋 Hesap: ${accountNo} - ${accountName}\n`;
      message += `   ${getCurrencyEmoji(currency)} ${formatNumber(foreignBalance)} ${currency}\n`;
      message += `   📈 Kur: ${formatNumber(currentRate)} TL\n`;
      message += `   💰 TL Karşılığı: ${formatNumber(tlEquivalent)} TL\n`;
      message += `   📊 Durum: ${status}\n\n`;
    }
  });

  return message;
}

// Kendi çeklerimizi güzel formatta sun
function formatOwnChecks(data: any[], reportType: string = 'ozet'): string {
  if (!data || data.length === 0) {
    return '❌ Çek/senet bilgisi bulunamadı.';
  }

  let message = reportType === 'ozet' ?
    '📄 **Kendi Çeklerimiz Özet**\n\n' :
    '📄 **Kendi Çeklerimiz Detay**\n\n';

  if (reportType === 'detay') {
    data.forEach((row, index) => {
      const recordDate = row['Kayıt Tarihi'] || 'N/A';
      const documentType = row['Evrak Türü'] || 'N/A';
      const documentNo = row['Evrak No'] || 'N/A';
      const bank = row['Bankası'] || 'N/A';
      const dueDate = row['Vadesi'] || 'N/A';
      const tlAmount = parseFloat(row['KPB Tutarı']) || 0;
      const foreignAmount = parseFloat(row['Döviz Tutarı']) || 0;
      const status = row['Evrak Durumu'] || 'N/A';

      if (documentType === 'Genel Toplam') {
        message += `📊 **${documentType}**\n`;
        message += `   💰 TL: ${formatNumber(tlAmount)}\n`;
        message += `   💱 Döviz: ${formatNumber(foreignAmount)}\n\n`;
      } else {
        message += `**${index + 1}.** ${documentType}\n`;
        message += `   📋 No: ${documentNo}\n`;
        message += `   🏦 Banka: ${bank}\n`;
        message += `   📅 Vade: ${dueDate}\n`;
        message += `   💰 Tutar: ${formatNumber(tlAmount)} TL\n`;
        message += `   📊 Durum: ${status}\n\n`;
      }
    });
  } else {
    data.forEach((row) => {
      const documentType = row['Evrak Türü'] || 'N/A';
      const tlAmount = parseFloat(row['Toplam KPB Tutarı']) || 0;
      const foreignAmount = parseFloat(row['Toplam Döviz Tutarı']) || 0;
      const tlValue = parseFloat(row['TL Değeri']) || 0;

      if (documentType === 'Genel Toplam') {
        message += `📊 **${documentType}**\n`;
        message += `   💰 **Toplam TL Değeri: ${formatNumber(tlValue)} TL**\n\n`;
      } else {
        message += `📄 **${documentType}**\n`;
        message += `   💰 TL: ${formatNumber(tlAmount)}\n`;
        message += `   💱 Döviz: ${formatNumber(foreignAmount)}\n`;
        message += `   📊 TL Değeri: ${formatNumber(tlValue)}\n\n`;
      }
    });
  }

  return message;
}

// Taşeron bakiye özetini güzel formatta sun


// Kasa bakiye detayını güzel formatta sun
function formatCashBalance(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Kasa bakiye bilgisi bulunamadı.';
  }

  let message = '💵 **Kasa Bakiye Detayı**\n\n';

  data.forEach((row) => {
    const cashName = row['Kasa Adı'] || 'N/A';
    const tlBalance = parseFloat(row['Net TL Bakiye']) || 0;
    const eurBalance = parseFloat(row['Net EUR Bakiye']) || 0;
    const eurTlEquivalent = parseFloat(row['EUR Bakiye (TL Karşılığı)']) || 0;
    const totalBalance = parseFloat(row['Kasa Toplam Bakiye (TL)']) || 0;

    if (cashName === 'Genel Toplam') {
      message += `📊 **${cashName}**\n`;
      message += `   💰 **Toplam: ${formatNumber(totalBalance)} TL**\n\n`;
    } else {
      message += `💵 **${cashName}**\n`;
      message += `   💰 TL: ${formatNumber(tlBalance)}\n`;
      message += `   💶 EUR: ${formatNumber(eurBalance)}\n`;
      message += `   📈 EUR (TL): ${formatNumber(eurTlEquivalent)}\n`;
      message += `   📊 Toplam: ${formatNumber(totalBalance)} TL\n\n`;
    }
  });

  return message;
}

// Teklif raporunu güzel formatta sun
function formatQuoteReport(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Teklif bilgisi bulunamadı.';
  }

  let message = '📋 **Teklif Raporu**\n\n';

  data.slice(0, 10).forEach((row, index) => {
    const quoteNo = row['TeklifNo'] || 'N/A';
    const quoteDate = row['TeklifTarihi'] || 'N/A';
    const customerName = row['CariUnvan'] || 'N/A';
    const quoteStatus = row['TeklifDurumu'] || 'N/A';
    const description = row['TeklifAciklamasi'] || 'N/A';
    const discountRate = parseFloat(row['TeklifIskontoOrani']) || 0;
    const totalAmount = parseFloat(row['GenelToplam']) || 0;
    const currency = row['ParaBirimi'] || 'TL';

    message += `**${index + 1}.** ${quoteNo}\n`;
    message += `   👤 Müşteri: ${customerName}\n`;
    message += `   📅 Tarih: ${quoteDate}\n`;
    message += `   📊 Durum: ${quoteStatus}\n`;
    message += `   💰 Tutar: ${formatNumber(totalAmount)} ${currency}\n`;
    if (discountRate > 0) {
      message += `   🏷️ İskonto: %${discountRate}\n`;
    }
    message += `   📝 Açıklama: ${description.substring(0, 50)}${description.length > 50 ? '...' : ''}\n\n`;
  });

  if (data.length > 10) {
    message += `_... ve ${data.length - 10} teklif daha var_\n\n`;
    message += `💬 _Daha detaylı bilgi için PDF raporu isteyebilirsiniz._`;
  }

  return message;
}

// Cari hareket raporunu güzel formatta sun
function formatCustomerMovement(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Cari hareket bilgisi bulunamadı.';
  }

  let message = '📈 **Cari Hareket Raporu**\n\n';

  data.slice(0, 15).forEach((row, index) => {
    const transactionDate = row['IslemTarihi'] || 'N/A';
    const documentNo = row['BelgeNo'] || 'N/A';
    const description = row['Aciklama'] || 'N/A';
    const transactionType = row['IslemTuru'] || 'N/A';
    const currency = row['ParaBirimi'] || 'TL';
    const debtAmount = parseFloat(row['BorcTutari']) || 0;
    const creditAmount = parseFloat(row['AlacakTutari']) || 0;
    const balance = parseFloat(row['SatirBakiyesi']) || 0;

    message += `**${index + 1}.** ${transactionDate}\n`;
    message += `   📋 Belge: ${documentNo}\n`;
    message += `   📝 Açıklama: ${description.substring(0, 40)}${description.length > 40 ? '...' : ''}\n`;
    message += `   🏷️ Tür: ${transactionType}\n`;

    if (debtAmount > 0) {
      message += `   📈 Borç: ${formatNumber(debtAmount)} ${currency}\n`;
    }
    if (creditAmount > 0) {
      message += `   📉 Alacak: ${formatNumber(creditAmount)} ${currency}\n`;
    }

    message += `   💰 Bakiye: ${formatNumber(balance)} ${currency}\n\n`;
  });

  if (data.length > 15) {
    message += `_... ve ${data.length - 15} hareket daha var_\n\n`;
    message += `💬 _Daha detaylı bilgi için PDF raporu isteyebilirsiniz._`;
  }

  return message;
}

// Cari hareket özet raporu (PDF öncesi)
function formatCustomerMovementSummary(data: any[], customerName?: string): string {
  if (!data || data.length === 0) {
    return '❌ Cari hareket bilgisi bulunamadı.';
  }

  const totalMovements = data.length;
  let totalDebit = 0;
  let totalCredit = 0;
  let finalBalance = 0;

  // Son bakiye ve toplamları hesapla
  data.forEach(row => {
    totalDebit += parseFloat(row['BorcTutari']) || 0;
    totalCredit += parseFloat(row['AlacakTutari']) || 0;
  });

  // Son hareketin bakiyesi
  if (data.length > 0) {
    finalBalance = parseFloat(data[data.length - 1]['SatirBakiyesi']) || 0;
  }

  // Tarih aralığını bul
  const dates = data.map(row => row['IslemTarihi']).filter(date => date);
  const startDate = dates.length > 0 ? dates[0] : 'N/A';
  const endDate = dates.length > 0 ? dates[dates.length - 1] : 'N/A';

  let message = `📈 **${customerName || 'Cari'} Hareket Özeti**\n\n`;

  message += `📊 **Genel Bilgiler:**\n`;
  message += `• Toplam Hareket: ${totalMovements} adet\n`;
  message += `• Tarih Aralığı: ${startDate} - ${endDate}\n\n`;

  message += `💰 **Finansal Özet:**\n`;
  message += `• Toplam Borç: ${formatNumber(totalDebit)} TL\n`;
  message += `• Toplam Alacak: ${formatNumber(totalCredit)} TL\n`;
  message += `• Güncel Bakiye: ${formatNumber(finalBalance)} TL\n\n`;

  // Son 3 hareketi göster
  message += `📋 **Son Hareketler:**\n`;
  const lastMovements = data.slice(-3).reverse();

  lastMovements.forEach((row, index) => {
    const date = row['IslemTarihi'] || 'N/A';
    const description = (row['Aciklama'] || 'N/A').substring(0, 40) + '...';
    const debit = parseFloat(row['BorcTutari']) || 0;
    const credit = parseFloat(row['AlacakTutari']) || 0;

    message += `${index + 1}. **${date}** - ${description}\n`;
    if (debit > 0) message += `   🔴 Borç: ${formatNumber(debit)} TL\n`;
    if (credit > 0) message += `   🟢 Alacak: ${formatNumber(credit)} TL\n`;
  });

  message += `\n📄 **Detaylı PDF raporu gönderiliyor...**`;

  return message;
}

// Genel bakiye toplam formatı - MCP TEST SAYFASI İLE BİREBİR AYNI
function formatGeneralBalanceTotal(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Genel bakiye toplam verisi bulunamadı.';
  }

  // Genel toplam satırını filtrele
  const dataRows = data.filter(row => row['Grubu'] !== 'GENEL TOPLAMLAR');
  const totalRow = data.find(row => row['Grubu'] === 'GENEL TOPLAMLAR');

  let message = `📊 **Bakiyeler Listesi Genel Toplam**\n\n`;
  message += `📊 **Toplam Kayıt:** ${dataRows.length}\n\n`;

  // MCP TEST SAYFASI TABLO BAŞLIKLARI:
  // Grubu | Ticari Ünvanı | Toplam Borç TL | Toplam Alacak TL | TL Bakiye | B/A | Toplam Borç EUR | Toplam Alacak EUR | EUR Bakiye | B/A EUR | Ara Grubu | Son Vade Tarihi | Son İşlem Tarihi

  // İlk 15 kaydı göster (özet için)
  dataRows.slice(0, 15).forEach((row, index) => {
    const grubu = row['Grubu'] || '-';
    const ticariUnvani = row['Ticari Ünvanı'] || '-';
    const toplamBorcTL = parseTurkishNumber(row['Toplam Borç TL']);
    const toplamAlacakTL = parseTurkishNumber(row['Toplam Alacak TL']);
    const tlBakiye = parseTurkishNumber(row['TL Bakiye']);
    const baStatusTL = row['B/A'] || '-';
    const toplamBorcEUR = parseTurkishNumber(row['Toplam Borç EUR']);
    const toplamAlacakEUR = parseTurkishNumber(row['Toplam Alacak EUR']);
    const eurBakiye = parseTurkishNumber(row['EUR Bakiye']);
    const baStatusEUR = row['B/A EUR'] || '-';
    const araGrubu = row['Ara Grubu'] || '-';
    const sonVadeTarihi = row['Son Vade Tarihi'] || '-';
    const sonIslemTarihi = row['Son İşlem Tarihi'] || '-';

    message += `**${index + 1}.** ${ticariUnvani}\n`;
    message += `   📂 **Grup:** ${grubu}\n`;

    // TL Bilgileri
    if (toplamBorcTL > 0 || toplamAlacakTL > 0 || tlBakiye !== 0) {
      message += `   💰 **TL:** Borç ${formatNumber(toplamBorcTL)} | Alacak ${formatNumber(toplamAlacakTL)} | **Net ${formatNumber(tlBakiye)}** (${baStatusTL})\n`;
    }

    // EUR Bilgileri
    if (toplamBorcEUR > 0 || toplamAlacakEUR > 0 || eurBakiye !== 0) {
      message += `   💶 **EUR:** Borç ${formatNumber(toplamBorcEUR)} | Alacak ${formatNumber(toplamAlacakEUR)} | **Net ${formatNumber(eurBakiye)}** (${baStatusEUR})\n`;
    }

    // Ek bilgiler (sadece dolu olanları göster)
    if (araGrubu !== '-' && araGrubu !== null) {
      message += `   📋 **Ara Grup:** ${araGrubu}\n`;
    }
    if (sonVadeTarihi !== '-' && sonVadeTarihi !== null) {
      message += `   📅 **Son Vade:** ${sonVadeTarihi}\n`;
    }
    if (sonIslemTarihi !== '-' && sonIslemTarihi !== null) {
      message += `   🕒 **Son İşlem:** ${sonIslemTarihi}\n`;
    }

    message += '\n';
  });

  if (dataRows.length > 15) {
    message += `📋 _... ve ${dataRows.length - 15} kayıt daha var_\n\n`;
  }

  // Genel toplam bilgisi (MCP test sayfasındaki gibi)
  if (totalRow) {
    message += `📊 **GENEL TOPLAMLAR:**\n`;
    const totalTLBorç = parseTurkishNumber(totalRow['Toplam Borç TL']);
    const totalTLAlacak = parseTurkishNumber(totalRow['Toplam Alacak TL']);
    const totalTLBakiye = parseTurkishNumber(totalRow['TL Bakiye']);
    const totalTLStatus = totalRow['B/A'] || '-';
    const totalEURBorç = parseTurkishNumber(totalRow['Toplam Borç EUR']);
    const totalEURAlacak = parseTurkishNumber(totalRow['Toplam Alacak EUR']);
    const totalEURBakiye = parseTurkishNumber(totalRow['EUR Bakiye']);
    const totalEURStatus = totalRow['B/A EUR'] || '-';

    message += `• **TL:** Borç ${formatNumber(totalTLBorç)} | Alacak ${formatNumber(totalTLAlacak)} | **Net ${formatNumber(totalTLBakiye)}** (${totalTLStatus})\n`;
    message += `• **EUR:** Borç ${formatNumber(totalEURBorç)} | Alacak ${formatNumber(totalEURAlacak)} | **Net ${formatNumber(totalEURBakiye)}** (${totalEURStatus})\n`;
  }

  message += `\n💡 **İpucu:** Tam tablo için "PDF oluştur" yazın - MCP test sayfasındaki ile birebir aynı tablo!`;

  return message;
}

// Banka bakiye listesi formatı
function formatBankBalanceList(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Banka bakiye listesi bulunamadı.';
  }

  let message = `🏦 **Banka Bakiye Listesi**\n\n`;

  data.forEach((row, index) => {
    const bankName = row['Banka Adı'] || 'N/A';
    const accountNo = row['Hesap No'] || 'N/A';
    const accountName = row['Hesap Adı'] || 'N/A';
    const currency = row['Para Birimi'] || 'TL';
    const balance = parseFloat(row['Bakiye']) || 0;
    const blockedAmount = parseFloat(row['Bloke Tutar']) || 0;
    const availableBalance = parseFloat(row['Kullanılabilir Bakiye']) || 0;

    message += `**${index + 1}. ${bankName}**\n`;
    message += `📋 Hesap: ${accountName} (${accountNo})\n`;
    message += `💰 Bakiye: ${formatNumber(balance)} ${currency}\n`;
    if (blockedAmount > 0) {
      message += `🔒 Bloke: ${formatNumber(blockedAmount)} ${currency}\n`;
    }
    message += `✅ Kullanılabilir: ${formatNumber(availableBalance)} ${currency}\n\n`;
  });

  return message;
}

// Cari bakiye listesi formatı
function formatCustomerBalanceList(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Cari bakiye listesi bulunamadı.';
  }

  let message = `👥 **Cari Bakiye Listesi**\n\n`;

  let totalDebt = 0;
  let totalReceivable = 0;

  data.forEach((row, index) => {
    const group = row['Cari Grubu'] || 'N/A';
    const customerName = row['Cari Ünvan'] || 'N/A';
    const currency = row['Para Birimi'] || 'TL';
    const debt = parseFloat(row['Toplam Borç']?.replace(/[^\d.-]/g, '')) || 0;
    const receivable = parseFloat(row['Toplam Alacak']?.replace(/[^\d.-]/g, '')) || 0;
    const netBalance = parseFloat(row['Net Bakiye']?.replace(/[^\d.-]/g, '')) || 0;
    const status = row['Durum'] || 'N/A';

    if (currency === 'TL') {
      totalDebt += debt;
      totalReceivable += receivable;
    }

    message += `**${index + 1}. ${customerName}**\n`;
    message += `📂 Grup: ${group}\n`;
    message += `💰 Net Bakiye: ${formatNumber(netBalance)} ${currency}\n`;
    message += `📊 Durum: ${status === 'Borçlu' ? '🔴' : status === 'Alacaklı' ? '🟢' : '⚪'} ${status}\n\n`;
  });

  message += `📈 **Genel Özet:**\n`;
  message += `• Toplam Borç: ${formatNumber(totalDebt)} TL\n`;
  message += `• Toplam Alacak: ${formatNumber(totalReceivable)} TL\n`;
  message += `• Net Durum: ${formatNumber(totalDebt - totalReceivable)} TL`;

  return message;
}

// Alacaklı bakiye listesi formatı - MCP TEST SAYFASI İLE BİREBİR AYNI
function formatReceivableBalanceList(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Alacaklı bakiye listesi bulunamadı.';
  }

  // Genel toplam satırını filtrele
  const dataRows = data.filter(row => row['Grubu'] !== 'GENEL TOPLAMLAR');
  const totalRow = data.find(row => row['Grubu'] === 'GENEL TOPLAMLAR');

  let message = `🟢 **Alacaklı Bakiye Listesi**\n\n`;
  message += `📊 **Toplam Kayıt:** ${dataRows.length}\n\n`;

  // MCP TEST SAYFASI TABLO BAŞLIKLARI:
  // Grubu | Ticari Ünvanı | Toplam Borç TL | Toplam Alacak TL | TL Bakiye | B/A | Toplam Borç EUR | Toplam Alacak EUR | EUR Bakiye | B/A EUR | Ara Grubu | Son Vade Tarihi | Son İşlem Tarihi

  // İlk 15 kaydı göster (özet için)
  dataRows.slice(0, 15).forEach((row, index) => {
    const grubu = row['Grubu'] || '-';
    const ticariUnvani = row['Ticari Ünvanı'] || '-';
    const toplamBorcTL = parseTurkishNumber(row['Toplam Borç TL']);
    const toplamAlacakTL = parseTurkishNumber(row['Toplam Alacak TL']);
    const tlBakiye = parseTurkishNumber(row['TL Bakiye']);
    const baStatusTL = row['B/A'] || '-';
    const toplamBorcEUR = parseTurkishNumber(row['Toplam Borç EUR']);
    const toplamAlacakEUR = parseTurkishNumber(row['Toplam Alacak EUR']);
    const eurBakiye = parseTurkishNumber(row['EUR Bakiye']);
    const baStatusEUR = row['B/A EUR'] || '-';
    const araGrubu = row['Ara Grubu'] || '-';
    const sonVadeTarihi = row['Son Vade Tarihi'] || '-';
    const sonIslemTarihi = row['Son İşlem Tarihi'] || '-';

    message += `**${index + 1}.** ${ticariUnvani}\n`;
    message += `   📂 **Grup:** ${grubu}\n`;

    // TL Bilgileri
    if (toplamBorcTL > 0 || toplamAlacakTL > 0 || tlBakiye !== 0) {
      message += `   💰 **TL:** Borç ${formatNumber(toplamBorcTL)} | Alacak ${formatNumber(toplamAlacakTL)} | **Net ${formatNumber(tlBakiye)}** (${baStatusTL})\n`;
    }

    // EUR Bilgileri
    if (toplamBorcEUR > 0 || toplamAlacakEUR > 0 || eurBakiye !== 0) {
      message += `   💶 **EUR:** Borç ${formatNumber(toplamBorcEUR)} | Alacak ${formatNumber(toplamAlacakEUR)} | **Net ${formatNumber(eurBakiye)}** (${baStatusEUR})\n`;
    }

    // Ek bilgiler
    if (araGrubu !== '-') {
      message += `   📋 **Ara Grup:** ${araGrubu}\n`;
    }
    if (sonVadeTarihi !== '-') {
      message += `   📅 **Son Vade:** ${sonVadeTarihi}\n`;
    }
    if (sonIslemTarihi !== '-') {
      message += `   🕒 **Son İşlem:** ${sonIslemTarihi}\n`;
    }

    message += '\n';
  });

  if (dataRows.length > 15) {
    message += `📋 _... ve ${dataRows.length - 15} kayıt daha var_\n\n`;
  }

  // Genel toplam bilgisi (MCP test sayfasındaki gibi)
  if (totalRow) {
    message += `📊 **GENEL TOPLAMLAR:**\n`;
    const totalTLBorç = parseTurkishNumber(totalRow['Toplam Borç TL']);
    const totalTLAlacak = parseTurkishNumber(totalRow['Toplam Alacak TL']);
    const totalTLBakiye = parseTurkishNumber(totalRow['TL Bakiye']);
    const totalTLStatus = totalRow['B/A'] || '-';
    const totalEURBorç = parseTurkishNumber(totalRow['Toplam Borç EUR']);
    const totalEURAlacak = parseTurkishNumber(totalRow['Toplam Alacak EUR']);
    const totalEURBakiye = parseTurkishNumber(totalRow['EUR Bakiye']);
    const totalEURStatus = totalRow['B/A EUR'] || '-';

    message += `• **TL:** Borç ${formatNumber(totalTLBorç)} | Alacak ${formatNumber(totalTLAlacak)} | **Net ${formatNumber(totalTLBakiye)}** (${totalTLStatus})\n`;
    message += `• **EUR:** Borç ${formatNumber(totalEURBorç)} | Alacak ${formatNumber(totalEURAlacak)} | **Net ${formatNumber(totalEURBakiye)}** (${totalEURStatus})\n`;
  }

  message += `\n💡 **İpucu:** Tam tablo için "PDF oluştur" yazın - MCP test sayfasındaki ile birebir aynı tablo!`;

  return message;
}

// Borçlu bakiye listesi formatı - MCP TEST SAYFASI İLE BİREBİR AYNI
function formatDebtorBalanceList(data: any[]): string {
  if (!data || data.length === 0) {
    return '❌ Borçlu bakiye listesi bulunamadı.';
  }

  // DEBUG: Veri yapısını kontrol et
  console.error('🔍 DEBUG - Toplam kayıt sayısı:', data.length);
  if (data.length > 0) {
    console.error('🔍 DEBUG - İlk satır alan adları:', Object.keys(data[0]));
    console.error('🔍 DEBUG - İlk satır RAW değerleri:', data[0]);

    // Her alan adını tek tek kontrol et
    const firstRow = data[0];
    console.error('🔍 DEBUG - Grubu değeri:', firstRow['Grubu']);
    console.error('🔍 DEBUG - Ticari Ünvanı değeri:', firstRow['Ticari Ünvanı']);
    console.error('🔍 DEBUG - Toplam Borç TL değeri:', firstRow['Toplam Borç TL']);
    console.error('🔍 DEBUG - TL Bakiye değeri:', firstRow['TL Bakiye']);
    console.error('🔍 DEBUG - B/A değeri:', firstRow['B/A']);
  }

  // Genel toplam satırını filtrele
  const dataRows = data.filter(row => row['Grubu'] !== 'GENEL TOPLAMLAR');
  const totalRow = data.find(row => row['Grubu'] === 'GENEL TOPLAMLAR');

  let message = `🔴 **Borçlu Bakiye Listesi**\n\n`;
  message += `📊 **Toplam Kayıt:** ${dataRows.length}\n\n`;

  // MCP TEST SAYFASI TABLO BAŞLIKLARI:
  // Grubu | Ticari Ünvanı | Toplam Borç TL | Toplam Alacak TL | TL Bakiye | B/A | Toplam Borç EUR | Toplam Alacak EUR | EUR Bakiye | B/A EUR | Ara Grubu | Son Vade Tarihi | Son İşlem Tarihi

  // İlk 15 kaydı göster (özet için)
  dataRows.slice(0, 15).forEach((row, index) => {
    const grubu = row['Grubu'] || '-';
    const ticariUnvani = row['Ticari Ünvanı'] || '-';
    const toplamBorcTL = parseTurkishNumber(row['Toplam Borç TL']);
    const toplamAlacakTL = parseTurkishNumber(row['Toplam Alacak TL']);
    const tlBakiye = parseTurkishNumber(row['TL Bakiye']);
    const baStatusTL = row['B/A'] || '-';
    const toplamBorcEUR = parseTurkishNumber(row['Toplam Borç EUR']);
    const toplamAlacakEUR = parseTurkishNumber(row['Toplam Alacak EUR']);
    const eurBakiye = parseTurkishNumber(row['EUR Bakiye']);
    const baStatusEUR = row['B/A EUR'] || '-';
    const araGrubu = row['Ara Grubu'] || '-';
    const sonVadeTarihi = row['Son Vade Tarihi'] || '-';
    const sonIslemTarihi = row['Son İşlem Tarihi'] || '-';

    message += `**${index + 1}.** ${ticariUnvani}\n`;
    message += `   📂 **Grup:** ${grubu}\n`;

    // TL Bilgileri
    if (toplamBorcTL > 0 || toplamAlacakTL > 0 || tlBakiye !== 0) {
      message += `   💰 **TL:** Borç ${formatNumber(toplamBorcTL)} | Alacak ${formatNumber(toplamAlacakTL)} | **Net ${formatNumber(tlBakiye)}** (${baStatusTL})\n`;
    }

    // EUR Bilgileri
    if (toplamBorcEUR > 0 || toplamAlacakEUR > 0 || eurBakiye !== 0) {
      message += `   💶 **EUR:** Borç ${formatNumber(toplamBorcEUR)} | Alacak ${formatNumber(toplamAlacakEUR)} | **Net ${formatNumber(eurBakiye)}** (${baStatusEUR})\n`;
    }

    // Ek bilgiler
    if (araGrubu !== '-') {
      message += `   📋 **Ara Grup:** ${araGrubu}\n`;
    }
    if (sonVadeTarihi !== '-') {
      message += `   📅 **Son Vade:** ${sonVadeTarihi}\n`;
    }
    if (sonIslemTarihi !== '-') {
      message += `   🕒 **Son İşlem:** ${sonIslemTarihi}\n`;
    }

    message += '\n';
  });

  if (dataRows.length > 15) {
    message += `📋 _... ve ${dataRows.length - 15} kayıt daha var_\n\n`;
  }

  // Genel toplam bilgisi (MCP test sayfasındaki gibi)
  if (totalRow) {
    message += `📊 **GENEL TOPLAMLAR:**\n`;
    const totalTLBorç = parseTurkishNumber(totalRow['Toplam Borç TL']);
    const totalTLAlacak = parseTurkishNumber(totalRow['Toplam Alacak TL']);
    const totalTLBakiye = parseTurkishNumber(totalRow['TL Bakiye']);
    const totalTLStatus = totalRow['B/A'] || '-';
    const totalEURBorç = parseTurkishNumber(totalRow['Toplam Borç EUR']);
    const totalEURAlacak = parseTurkishNumber(totalRow['Toplam Alacak EUR']);
    const totalEURBakiye = parseTurkishNumber(totalRow['EUR Bakiye']);
    const totalEURStatus = totalRow['B/A EUR'] || '-';

    message += `• **TL:** Borç ${formatNumber(totalTLBorç)} | Alacak ${formatNumber(totalTLAlacak)} | **Net ${formatNumber(totalTLBakiye)}** (${totalTLStatus})\n`;
    message += `• **EUR:** Borç ${formatNumber(totalEURBorç)} | Alacak ${formatNumber(totalEURAlacak)} | **Net ${formatNumber(totalEURBakiye)}** (${totalEURStatus})\n`;
  }

  message += `\n💡 **İpucu:** Tam tablo için "PDF oluştur" yazın - MCP test sayfasındaki ile birebir aynı tablo!`;

  return message;
}

// Teklif detayını güzel formatta sun
function formatQuoteDetail(data: any[], quoteNumber: string): string {
  if (!data || data.length === 0) {
    return `❌ ${quoteNumber} numaralı teklif detayı bulunamadı.`;
  }

  let message = `📋 **Teklif Detayı: ${quoteNumber}**\n\n`;

  // İlk satırdan genel bilgileri al
  const firstRow = data[0];
  const customerName = firstRow['CariUnvan'] || 'N/A';
  const quoteDate = firstRow['TeklifTarihi'] || 'N/A';
  const quoteStatus = firstRow['TeklifDurumu'] || 'N/A';
  const currency = firstRow['ParaBirimi'] || 'TL';
  const discountRate = parseFloat(firstRow['TeklifIskontoOrani']) || 0;

  message += `👤 **Müşteri:** ${customerName}\n`;
  message += `📅 **Tarih:** ${quoteDate}\n`;
  message += `📊 **Durum:** ${quoteStatus}\n`;
  if (discountRate > 0) {
    message += `🏷️ **İskonto:** %${discountRate}\n`;
  }
  message += `💰 **Para Birimi:** ${currency}\n\n`;

  // Teklif kalemlerini listele
  message += `📦 **Teklif Kalemleri:**\n\n`;

  let totalAmount = 0;
  data.forEach((row, index) => {
    const itemCode = row['StokKodu'] || 'N/A';
    const itemName = row['StokAdi'] || 'N/A';
    const quantity = parseFloat(row['Miktar']) || 0;
    const unitPrice = parseFloat(row['BirimFiyat']) || 0;
    const lineTotal = parseFloat(row['SatirToplami']) || 0;
    const unit = row['Birim'] || 'Adet';

    message += `**${index + 1}.** ${itemName}\n`;
    message += `   📋 Kod: \`${itemCode}\`\n`;
    message += `   📊 Miktar: ${formatNumber(quantity)} ${unit}\n`;
    message += `   💵 Birim Fiyat: ${formatNumber(unitPrice)} ${currency}\n`;
    message += `   💰 Toplam: ${formatNumber(lineTotal)} ${currency}\n\n`;

    totalAmount += lineTotal;
  });

  // Genel toplam
  message += `📊 **Genel Toplam: ${formatNumber(totalAmount)} ${currency}**\n\n`;

  if (data.length > 10) {
    message += `💬 _Detaylı rapor için PDF talep edebilirsiniz._`;
  }

  return message;
}

// Hızlı teklif detayı formatı (PDF ile birlikte)
function formatQuoteDetailQuick(data: any[], quoteNumber: string): string {
  if (!data || data.length === 0) {
    return `❌ ${quoteNumber} numaralı teklif detayı bulunamadı.`;
  }

  // İlk satırdan genel bilgileri al
  const firstRow = data[0];
  const customerName = firstRow['CariUnvan'] || 'N/A';
  const quoteDate = firstRow['TeklifTarihi'] || 'N/A';

  // Hızlı özet hesaplama
  let totalAmount = 0;
  data.forEach(row => {
    const brutFiyat = parseFloat(row['BrutBirimFiyat']) || 0;
    const miktar = parseFloat(row['Miktar']) || 0;
    const iskonto1 = parseFloat(row['IskontoOrani1']) || 0;
    const iskonto2 = parseFloat(row['IskontoOrani2']) || 0;

    let netFiyat = brutFiyat;
    if (iskonto1 > 0) netFiyat = netFiyat * (1 - iskonto1 / 100);
    if (iskonto2 > 0) netFiyat = netFiyat * (1 - iskonto2 / 100);

    totalAmount += (netFiyat * miktar);
  });

  const totalKDV = totalAmount * 0.20;
  const grandTotal = totalAmount + totalKDV;

  let message = `📋 **${quoteNumber} Teklif Detayı**\n\n`;
  message += `👤 **Müşteri:** ${customerName}\n`;
  message += `📅 **Tarih:** ${quoteDate}\n`;
  message += `📦 **Kalem Sayısı:** ${data.length}\n\n`;

  message += `💰 **Finansal Özet:**\n`;
  message += `• Ara Toplam: ${formatNumber(totalAmount)} TL\n`;
  message += `• KDV (%20): ${formatNumber(totalKDV)} TL\n`;
  message += `• **Genel Toplam: ${formatNumber(grandTotal)} TL**\n\n`;

  message += `📄 **Detaylı PDF raporu hazırlanıyor ve size gönderilecek...**`;

  return message;
}



// Parametreli bakiyeler listesi formatı - MCP TEST SAYFASI İLE BİREBİR AYNI
function formatBalanceList(data: any[], args: any, userId?: number, title: string = 'Parametreli Bakiyeler Listesi'): string {
  if (!data || data.length === 0) {
    return '❌ Bakiyeler listesi bulunamadı.';
  }



  // Genel toplam satırını filtrele
  const dataRows = data.filter(row => row['Grubu'] !== 'GENEL TOPLAMLAR');
  const totalRow = data.find(row => row['Grubu'] === 'GENEL TOPLAMLAR');

  let message = '📊 **Parametreli Bakiyeler Listesi**\n\n';

  // Filtre bilgilerini göster
  if (args.grup_filtresi || args.ticari_unvan_filtresi || args.bakiye_durumu_filtresi) {
    message += '🔍 **Uygulanan Filtreler:**\n';
    if (args.grup_filtresi) message += `• Grup: ${args.grup_filtresi}\n`;
    if (args.ticari_unvan_filtresi) message += `• Ticari Ünvan: ${args.ticari_unvan_filtresi}\n`;
    if (args.bakiye_durumu_filtresi) message += `• Bakiye Durumu: ${args.bakiye_durumu_filtresi}\n`;
    message += '\n';
  }

  message += `📊 **Toplam Kayıt:** ${dataRows.length}\n\n`;

  // Genel toplam bilgilerini göster
  if (totalRow) {
    message += '📈 **Genel Toplam:**\n';

    const totalTLBorç = parseTurkishNumber(totalRow['Toplam Borç TL']);
    const totalTLAlacak = parseTurkishNumber(totalRow['Toplam Alacak TL']);
    const totalTLBakiye = parseTurkishNumber(totalRow['TL Bakiye']);
    const totalTLStatus = totalRow['B/A'] || '-';
    const totalEURBorç = parseTurkishNumber(totalRow['Toplam Borç EUR']);
    const totalEURAlacak = parseTurkishNumber(totalRow['Toplam Alacak EUR']);
    const totalEURBakiye = parseTurkishNumber(totalRow['EUR Bakiye']);

    if (totalTLBakiye !== 0) {
      message += `• **TL:** ${formatNumber(Math.abs(totalTLBakiye))} TL ${totalTLStatus === 'Borçlu' ? 'net borç' : 'net alacak'}\n`;
    }
    if (totalEURBakiye !== 0) {
      message += `• **EUR:** ${formatNumber(Math.abs(totalEURBakiye))} EUR ${totalRow['B/A EUR'] === 'Borçlu' ? 'net borç' : 'net alacak'}\n`;
    }
    message += '\n';
  }

  // Eğer 10'dan fazla kayıt varsa PDF otomatik gönder
  if (dataRows.length > 10) {
    message += '📄 **Detaylı liste PDF olarak hazırlanıyor...**\n\n';
    message += '💡 **İpucu:** Daha detaylı bilgi almak veya belirli bir müşterinin bakiyesini sorgulamak isterseniz, lütfen belirtin.\n';

    // PDF'i arka planda oluştur ve gönder
    if (userId) {
      setTimeout(async () => {
        try {
          // Tüm veriyi gönder (GENEL TOPLAMLAR dahil)
          const pdfPath = await generatePDF(data, 'balanceList', title);
          await bot.sendDocument(userId, pdfPath, {
            caption: `📊 **${title}**\n\n✅ ${dataRows.length} kayıt\n📅 ${new Date().toLocaleDateString('tr-TR')}`
          }, {
            contentType: 'application/pdf',
            filename: `${title.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`
          });

          // Dosyayı sil
          setTimeout(() => {
            if (fs.existsSync(pdfPath)) {
              fs.unlinkSync(pdfPath);
            }
          }, 5000);
        } catch (pdfError) {
          console.error('PDF oluşturma hatası:', pdfError);
          await bot.sendMessage(userId, '❌ PDF oluşturulurken hata oluştu.');
        }
      }, 500);
    }

    return message;
  }

  // MCP TEST SAYFASI TABLO BAŞLIKLARI:
  // Grubu | Ticari Ünvanı | Toplam Borç TL | Toplam Alacak TL | TL Bakiye | B/A | Toplam Borç EUR | Toplam Alacak EUR | EUR Bakiye | B/A EUR | Ara Grubu | Son Vade Tarihi | Son İşlem Tarihi

  // Az kayıt varsa listeyi göster
  dataRows.forEach((row, index) => {
    const grubu = row['Grubu'] || '-';
    const ticariUnvani = row['Ticari Ünvanı'] || '-';
    const toplamBorcTL = parseTurkishNumber(row['Toplam Borç TL']);
    const toplamAlacakTL = parseTurkishNumber(row['Toplam Alacak TL']);
    const tlBakiye = parseTurkishNumber(row['TL Bakiye']);
    const baStatusTL = row['B/A'] || '-';
    const toplamBorcEUR = parseTurkishNumber(row['Toplam Borç EUR']);
    const toplamAlacakEUR = parseTurkishNumber(row['Toplam Alacak EUR']);
    const eurBakiye = parseTurkishNumber(row['EUR Bakiye']);
    const baStatusEUR = row['B/A EUR'] || '-';
    const araGrubu = row['Ara Grubu'] || '-';
    const sonVadeTarihi = row['Son Vade Tarihi'] || '-';
    const sonIslemTarihi = row['Son İşlem Tarihi'] || '-';

    message += `**${index + 1}.** ${ticariUnvani}\n`;
    message += `   📂 **Grup:** ${grubu}\n`;

    // TL Bilgileri
    if (toplamBorcTL > 0 || toplamAlacakTL > 0 || tlBakiye !== 0) {
      message += `   💰 **TL:** Borç ${formatNumber(toplamBorcTL)} | Alacak ${formatNumber(toplamAlacakTL)} | **Net ${formatNumber(tlBakiye)}** (${baStatusTL})\n`;
    }

    // EUR Bilgileri
    if (toplamBorcEUR > 0 || toplamAlacakEUR > 0 || eurBakiye !== 0) {
      message += `   💶 **EUR:** Borç ${formatNumber(toplamBorcEUR)} | Alacak ${formatNumber(toplamAlacakEUR)} | **Net ${formatNumber(eurBakiye)}** (${baStatusEUR})\n`;
    }

    // Ek bilgiler (sadece dolu olanları göster)
    if (araGrubu !== '-' && araGrubu !== null) {
      message += `   📋 **Ara Grup:** ${araGrubu}\n`;
    }
    if (sonVadeTarihi !== '-' && sonVadeTarihi !== null) {
      message += `   📅 **Son Vade:** ${sonVadeTarihi}\n`;
    }
    if (sonIslemTarihi !== '-' && sonIslemTarihi !== null) {
      message += `   🕒 **Son İşlem:** ${sonIslemTarihi}\n`;
    }

    message += '\n';
  });

  if (dataRows.length > 15) {
    message += `📋 _... ve ${dataRows.length - 15} kayıt daha var_\n\n`;
  }

  // Genel toplam bilgisi (MCP test sayfasındaki gibi)
  if (totalRow) {
    message += `📊 **GENEL TOPLAMLAR:**\n`;
    const totalTLBorç = parseTurkishNumber(totalRow['Toplam Borç TL']);
    const totalTLAlacak = parseTurkishNumber(totalRow['Toplam Alacak TL']);
    const totalTLBakiye = parseTurkishNumber(totalRow['TL Bakiye']);
    const totalTLStatus = totalRow['B/A'] || '-';
    const totalEURBorç = parseTurkishNumber(totalRow['Toplam Borç EUR']);
    const totalEURAlacak = parseTurkishNumber(totalRow['Toplam Alacak EUR']);
    const totalEURBakiye = parseTurkishNumber(totalRow['EUR Bakiye']);
    const totalEURStatus = totalRow['B/A EUR'] || '-';

    message += `• **TL:** Borç ${formatNumber(totalTLBorç)} | Alacak ${formatNumber(totalTLAlacak)} | **Net ${formatNumber(totalTLBakiye)}** (${totalTLStatus})\n`;
    message += `• **EUR:** Borç ${formatNumber(totalEURBorç)} | Alacak ${formatNumber(totalEURAlacak)} | **Net ${formatNumber(totalEURBakiye)}** (${totalEURStatus})\n`;
  }

  message += `\n💡 **İpucu:** Tam tablo için "PDF oluştur" yazın - MCP test sayfasındaki ile birebir aynı tablo!`;

  return message;
}

// PDF oluşturma fonksiyonu (Logo ile)
async function generatePDF(data: any[], reportType: string, title: string): Promise<string> {
  try {
    // Logo dosyasını base64'e çevir
    const logoPath = path.join(process.cwd(), 'tarslogo.png');
    let logoBase64 = '';

    try {
      const logoBuffer = fs.readFileSync(logoPath);
      logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
    } catch (logoError) {
      console.log('Logo dosyası bulunamadı, logo olmadan devam ediliyor...');
    }

    // Tablo genişliğine göre sayfa boyutu ve yönü belirle - Daha akıllı boyutlandırma
    const columnCount = data.length > 0 ? Object.keys(data[0]).length : 5;
    let pageSize = 'A4';
    let orientation = 'portrait';

    // Rapor türüne göre optimal sayfa boyutu
    if (reportType === 'quoteDetail') {
      pageSize = 'A2'; // En geniş tablo - 11 kolon
      orientation = 'landscape';
    } else if (reportType === 'quoteReport') {
      pageSize = 'A3'; // Geniş tablo - 10 kolon
      orientation = 'landscape';
    } else if (reportType === 'customerMovement') {
      pageSize = 'A3'; // Cari hareket tablosu - 8 kolon
      orientation = 'landscape';
    } else if (columnCount > 8) {
      pageSize = 'A3';
      orientation = 'landscape';
    } else if (columnCount > 5) {
      pageSize = 'A4';
      orientation = 'landscape';
    }

    const isWideTable = orientation === 'landscape';

    // HTML içeriği oluştur - Kurumsal tasarım
    let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>${title}</title>
        <style>
            @page {
                size: ${pageSize} ${orientation};
                margin: ${isWideTable ? '8mm' : '12mm'};
            }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                margin: 0;
                color: #333;
                line-height: 1.4;
                font-size: ${isWideTable ? '11px' : '12px'};
                background: #fafafa;
            }
            .header {
                background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
                border: 2px solid #007acc;
                border-radius: 15px;
                padding: ${isWideTable ? '15px' : '25px'};
                margin-bottom: 20px;
                box-shadow: 0 8px 25px rgba(0,122,204,0.15);
                position: relative;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .header::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 4px;
                background: linear-gradient(90deg, #007acc 0%, #0056b3 50%, #007acc 100%);
            }
            .logo-section {
                flex: 0 0 auto;
                margin-right: 25px;
            }
            .logo {
                max-width: ${isWideTable ? '120px' : '180px'};
                max-height: ${isWideTable ? '70px' : '100px'};
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            }
            .title-section {
                flex: 1;
                text-align: center;
            }
            .company-name {
                font-size: ${isWideTable ? '22px' : '28px'};
                font-weight: 700;
                color: #007acc;
                margin-bottom: 6px;
                text-shadow: 1px 1px 3px rgba(0,0,0,0.1);
                letter-spacing: 1px;
            }
            .report-title {
                font-size: ${isWideTable ? '16px' : '20px'};
                font-weight: 600;
                color: #2c3e50;
                margin-bottom: 6px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .report-date {
                font-size: ${isWideTable ? '11px' : '12px'};
                color: #6c757d;
                font-style: italic;
                background: #e9ecef;
                padding: 4px 12px;
                border-radius: 15px;
                display: inline-block;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.1);
                border-radius: 10px;
                overflow: hidden;
                background: white;
                table-layout: auto;
            }
            th {
                background: linear-gradient(135deg, #007acc 0%, #005a9e 100%);
                color: white;
                padding: ${isWideTable ? '8px 5px' : '12px 8px'};
                text-align: center;
                font-weight: bold;
                font-size: ${isWideTable ? '10px' : '12px'};
                text-transform: uppercase;
                letter-spacing: 0.3px;
                border-right: 1px solid rgba(255,255,255,0.2);
                white-space: nowrap;
                min-width: fit-content;
            }
            th:last-child {
                border-right: none;
            }
            td {
                padding: ${isWideTable ? '6px 4px' : '8px 6px'};
                border-bottom: 1px solid #e0e0e0;
                border-right: 1px solid #f0f0f0;
                font-size: ${isWideTable ? '9px' : '11px'};
                word-wrap: break-word;
                overflow-wrap: break-word;
                vertical-align: top;
                max-width: 200px;
            }
            td:last-child {
                border-right: none;
            }
            /* Kolon genişlik optimizasyonu */
            th:nth-child(1), td:nth-child(1) { width: 8%; } /* Teklif No */
            th:nth-child(2), td:nth-child(2) { width: 15%; } /* Açıklama */
            th:nth-child(3), td:nth-child(3) { width: 15%; } /* Cari Ünvan */
            th:nth-child(4), td:nth-child(4) { width: 8%; } /* Durum */
            th:nth-child(5), td:nth-child(5) { width: 10%; } /* Ürün Kodu */
            th:nth-child(6), td:nth-child(6) { width: 20%; } /* Ürün Adı */
            th:nth-child(7), td:nth-child(7) { width: 6%; } /* Miktar */
            th:nth-child(8), td:nth-child(8) { width: 5%; } /* Birim */
            th:nth-child(9), td:nth-child(9) { width: 8%; } /* Brüt Fiyat */
            th:nth-child(10), td:nth-child(10) { width: 5%; } /* İsk1 */
            th:nth-child(11), td:nth-child(11) { width: 5%; } /* İsk2 */
            th:nth-child(12), td:nth-child(12) { width: 10%; } /* İndirimli Fiyat */
            tr:nth-child(even) {
                background-color: #f8f9fa;
            }
            tr:hover {
                background-color: #e3f2fd;
                transition: background-color 0.3s ease;
            }
            .number {
                text-align: right;
                font-weight: bold;
                color: #2e7d32;
            }
            .total-row {
                background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%) !important;
                font-weight: bold;
                border-top: 2px solid #007acc;
            }
            .total-row td {
                font-size: 14px;
                padding: 15px 12px;
            }
            .footer {
                margin-top: 30px;
                text-align: center;
                font-size: ${isWideTable ? '10px' : '11px'};
                color: #6c757d;
                border-top: 2px solid #007acc;
                padding: ${isWideTable ? '12px' : '18px'};
                background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
                border-radius: 8px;
                box-shadow: 0 -2px 8px rgba(0,0,0,0.05);
            }
            .stats-box {
                background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
                border: 1px solid #dee2e6;
                border-radius: 10px;
                padding: ${isWideTable ? '10px' : '15px'};
                margin: ${isWideTable ? '10px 0' : '15px 0'};
                border-left: 4px solid #007acc;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                display: inline-block;
                margin-right: 15px;
                vertical-align: top;
            }
            .stats-title {
                font-weight: bold;
                color: #007acc;
                margin-bottom: 8px;
                font-size: ${isWideTable ? '11px' : '12px'};
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .stats-box div:not(.stats-title) {
                font-size: ${isWideTable ? '10px' : '11px'};
                margin-bottom: 4px;
                color: #495057;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="logo-section">
                ${logoBase64 ? `<img src="${logoBase64}" alt="TAR-S Logo" class="logo">` : ''}
            </div>
            <div class="title-section">
                <div class="company-name">TAR-S ERP Sistemi</div>
                <div class="report-title">${title}</div>
                <div class="report-date">Rapor Tarihi: ${new Date().toLocaleDateString('tr-TR')} ${new Date().toLocaleTimeString('tr-TR')}</div>
            </div>
        </div>
    `;

    if (reportType === 'balanceList') {
      // Bakiye listesi için istatistik kutusu
      const groupCount = new Set(data.map(row => row['Grubu'])).size;
      const totalTLBalance = data.reduce((sum, row) => sum + (parseTurkishNumber(row['TL Bakiye']) || 0), 0);
      const totalEURBalance = data.reduce((sum, row) => sum + (parseTurkishNumber(row['EUR Bakiye']) || 0), 0);

      htmlContent += `
        <div class="stats-box">
          <div class="stats-title">📊 Rapor Özeti</div>
          <div><strong>Toplam Kayıt:</strong> ${data.length}</div>
          <div><strong>Grup Sayısı:</strong> ${groupCount}</div>
          <div><strong>TL Toplam:</strong> ${formatNumber(totalTLBalance)} TL</div>
          <div><strong>EUR Toplam:</strong> ${formatNumber(totalEURBalance)} EUR</div>
        </div>
      `;

      // Bakiye listesi için tablo başlıkları
      htmlContent += `<table><thead><tr>
        <th>Grubu</th>
        <th>Ticari Ünvanı</th>
        <th>Toplam Borç TL</th>
        <th>Toplam Alacak TL</th>
        <th>TL Bakiye</th>
        <th>B/A</th>
        <th>Toplam Borç EUR</th>
        <th>Toplam Alacak EUR</th>
        <th>EUR Bakiye</th>
        <th>B/A EUR</th>
        <th>Ara Grubu</th>
        <th>Son Vade Tarihi</th>
        <th>Son İşlem Tarihi</th>
      </tr></thead><tbody>`;

      // Genel toplam satırını filtrele
      const dataRows = data.filter(row => row['Grubu'] !== 'GENEL TOPLAMLAR');
      const totalRow = data.find(row => row['Grubu'] === 'GENEL TOPLAMLAR');

      // Normal satırları ekle
      dataRows.forEach(row => {
        htmlContent += `<tr>
          <td>${row['Grubu'] || '-'}</td>
          <td>${row['Ticari Ünvanı'] || '-'}</td>
          <td class="number">${formatNumber(parseTurkishNumber(row['Toplam Borç TL']))}</td>
          <td class="number">${formatNumber(parseTurkishNumber(row['Toplam Alacak TL']))}</td>
          <td class="number">${formatNumber(parseTurkishNumber(row['TL Bakiye']))}</td>
          <td>${row['B/A'] || '-'}</td>
          <td class="number">${formatNumber(parseTurkishNumber(row['Toplam Borç EUR']))}</td>
          <td class="number">${formatNumber(parseTurkishNumber(row['Toplam Alacak EUR']))}</td>
          <td class="number">${formatNumber(parseTurkishNumber(row['EUR Bakiye']))}</td>
          <td>${row['B/A EUR'] || '-'}</td>
          <td>${row['Ara Grubu'] || '-'}</td>
          <td>${row['Son Vade Tarihi'] || '-'}</td>
          <td>${row['Son İşlem Tarihi'] || '-'}</td>
        </tr>`;
      });

      // Genel toplam satırını ekle (eğer varsa)
      if (totalRow) {
        htmlContent += `<tr class="total-row">
          <td><strong>GENEL TOPLAMLAR</strong></td>
          <td><strong>-</strong></td>
          <td class="number"><strong>${formatNumber(parseTurkishNumber(totalRow['Toplam Borç TL']))}</strong></td>
          <td class="number"><strong>${formatNumber(parseTurkishNumber(totalRow['Toplam Alacak TL']))}</strong></td>
          <td class="number"><strong>${formatNumber(parseTurkishNumber(totalRow['TL Bakiye']))}</strong></td>
          <td><strong>${totalRow['B/A'] || '-'}</strong></td>
          <td class="number"><strong>${formatNumber(parseTurkishNumber(totalRow['Toplam Borç EUR']))}</strong></td>
          <td class="number"><strong>${formatNumber(parseTurkishNumber(totalRow['Toplam Alacak EUR']))}</strong></td>
          <td class="number"><strong>${formatNumber(parseTurkishNumber(totalRow['EUR Bakiye']))}</strong></td>
          <td><strong>${totalRow['B/A EUR'] || '-'}</strong></td>
          <td><strong>-</strong></td>
          <td><strong>-</strong></td>
          <td><strong>-</strong></td>
        </tr>`;
      }

    } else if (reportType === 'bankBalances') {
      // Banka bakiyeleri için istatistik kutusu
      const bankCount = new Set(data.map(row => row['Banka Adı'])).size;
      const currencyCount = new Set(data.map(row => row['Para Birimi'])).size;

      htmlContent += `
        <div class="stats-box">
          <div class="stats-title">📊 Rapor Özeti</div>
          <div><strong>Toplam Hesap:</strong> ${data.length}</div>
          <div><strong>Banka Sayısı:</strong> ${bankCount}</div>
          <div><strong>Para Birimi:</strong> ${currencyCount}</div>
        </div>
      `;

      // Banka bakiyeleri için özel format
      htmlContent += `<table><thead><tr><th>Banka Adı</th><th>Para Birimi</th><th>Bakiye</th></tr></thead><tbody>`;

      let totalsByBank: { [key: string]: { [key: string]: number } } = {};

      data.forEach(row => {
        const bankName = row['Banka Adı'];
        const currency = row['Para Birimi'];
        const balance = parseFloat(row['Bakiye']) || 0;

        if (!bankName.includes('TOPLAM') && currency && balance !== 0) {
          if (!totalsByBank[bankName]) {
            totalsByBank[bankName] = {};
          }
          totalsByBank[bankName][currency] = (totalsByBank[bankName][currency] || 0) + balance;
        }
      });

      Object.keys(totalsByBank).forEach(bankName => {
        Object.keys(totalsByBank[bankName]).forEach(currency => {
          const total = totalsByBank[bankName][currency];
          htmlContent += `<tr>
            <td>${bankName}</td>
            <td>${currency}</td>
            <td class="number">${total.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>`;
        });
      });

      // Genel toplam
      let grandTotals: { [key: string]: number } = {};
      Object.values(totalsByBank).forEach(bankTotals => {
        Object.keys(bankTotals).forEach(currency => {
          grandTotals[currency] = (grandTotals[currency] || 0) + bankTotals[currency];
        });
      });

      Object.keys(grandTotals).forEach(currency => {
        htmlContent += `<tr class="total-row">
          <td><strong>GENEL TOPLAM</strong></td>
          <td><strong>${currency}</strong></td>
          <td class="number"><strong>${grandTotals[currency].toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
        </tr>`;
      });

    } else if (reportType === 'stockReport') {
      // Stok raporu için istatistik kutusu
      const totalQuantity = data.reduce((sum, row) => sum + (parseFloat(row['MIKTAR'] || row['miktar']) || 0), 0);
      const activeProducts = data.filter(row => (parseFloat(row['MIKTAR'] || row['miktar']) || 0) > 0).length;

      htmlContent += `
        <div class="stats-box">
          <div class="stats-title">📦 Stok Özeti</div>
          <div><strong>Toplam Ürün:</strong> ${data.length}</div>
          <div><strong>Stokta Olan:</strong> ${activeProducts}</div>
          <div><strong>Toplam Miktar:</strong> ${totalQuantity.toLocaleString('tr-TR')}</div>
        </div>
      `;

      // Stok raporu için format
      htmlContent += `<table><thead><tr><th>Sıra</th><th>Stok Kodu</th><th>Stok Adı</th><th>Miktar</th></tr></thead><tbody>`;

      data.forEach((row, index) => {
        const stockCode = row['STOK_KODU'] || row['stok_kodu'] || 'N/A';
        const stockName = row['STOK_ADI'] || row['stok_adi'] || 'N/A';
        const quantity = row['MIKTAR'] || row['miktar'] || 0;

        htmlContent += `<tr>
          <td>${index + 1}</td>
          <td>${stockCode}</td>
          <td>${stockName}</td>
          <td class="number">${parseFloat(quantity).toLocaleString('tr-TR')}</td>
        </tr>`;
      });

    } else if (reportType === 'quoteDetail') {
      // Teklif detayı için MCP-TEST sayfasındaki gerçek alan adları
      const firstRow = data[0] || {};
      const quoteNo = firstRow['AnaTeklifNo'] || 'N/A';
      const customerName = firstRow['CariUnvan'] || 'N/A';
      const status = firstRow['TeklifDurumu'] || 'Aktif';
      const itemCount = data.length;

      htmlContent += `
        <div class="stats-box">
          <div class="stats-title">📋 Teklif Bilgileri</div>
          <div><strong>Teklif No:</strong> ${quoteNo}</div>
          <div><strong>Müşteri:</strong> ${customerName}</div>
          <div><strong>Durum:</strong> ${status}</div>
          <div><strong>Kalem Sayısı:</strong> ${itemCount}</div>
        </div>
      `;

      // MCP-TEST sayfasındaki tablo başlıkları birebir aynı
      htmlContent += `<table><thead><tr>
        <th>AnaTeklifNo</th>
        <th>TeklifGenelAciklama</th>
        <th>CariUnvan</th>
        <th>TeklifDurumu</th>
        <th>UrunKodu</th>
        <th>UrunAdi</th>
        <th>Miktar</th>
        <th>Birim</th>
        <th>BrutBirimFiyat</th>
        <th>IskontoOrani1</th>
        <th>IskontoOrani2</th>
        <th>IndirimliBirimFiyat</th>
      </tr></thead><tbody>`;

      data.forEach((row) => {
        const anaTeklifNo = row['AnaTeklifNo'] || 'N/A';
        const teklifGenelAciklama = row['TeklifGenelAciklama'] || '-';
        const cariUnvan = row['CariUnvan'] || 'N/A';
        const teklifDurumu = row['TeklifDurumu'] || 'N/A';
        const urunKodu = row['UrunKodu'] || 'N/A';
        const urunAdi = row['UrunAdi'] || 'N/A';
        const miktar = parseFloat(row['Miktar']) || 0;
        const birim = row['Birim'] || 'ADET';
        const brutBirimFiyat = parseFloat(row['BrutBirimFiyat']) || 0;
        const iskontoOrani1 = parseFloat(row['IskontoOrani1']) || 0;
        const iskontoOrani2 = parseFloat(row['IskontoOrani2']) || 0;
        const indirimliBirimFiyat = parseFloat(row['IndirimliBirimFiyat_KDVHaric']) || 0;

        htmlContent += `<tr>
          <td style="font-weight: bold; color: #007acc;">${anaTeklifNo}</td>
          <td style="max-width: 120px; word-wrap: break-word;">${teklifGenelAciklama}</td>
          <td style="max-width: 150px; word-wrap: break-word;">${cariUnvan}</td>
          <td>${teklifDurumu}</td>
          <td>${urunKodu}</td>
          <td style="max-width: 200px; word-wrap: break-word;">${urunAdi}</td>
          <td class="number">${miktar.toLocaleString('tr-TR')}</td>
          <td>${birim}</td>
          <td class="number">${brutBirimFiyat.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</td>
          <td class="number">${iskontoOrani1.toFixed(1)}%</td>
          <td class="number">${iskontoOrani2.toFixed(1)}%</td>
          <td class="number" style="font-weight: bold; color: #2e7d32;">${indirimliBirimFiyat.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</td>
        </tr>`;
      });

      // Genel Toplam hesaplama
      const totalAmount = data.reduce((sum, row) => {
        const indirimliBirimFiyat = parseFloat(row['IndirimliBirimFiyat_KDVHaric']) || 0;
        const miktar = parseFloat(row['Miktar']) || 0;
        return sum + (indirimliBirimFiyat * miktar);
      }, 0);

      const totalKDV = totalAmount * 0.20; // %20 KDV
      const grandTotal = totalAmount + totalKDV;

      // Toplam satırları
      htmlContent += `<tr class="total-row">
        <td colspan="11"><strong>ARA TOPLAM (KDV HARİÇ)</strong></td>
        <td class="number"><strong>${totalAmount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</strong></td>
      </tr>`;
      htmlContent += `<tr class="total-row">
        <td colspan="11"><strong>KDV (%20)</strong></td>
        <td class="number"><strong>${totalKDV.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</strong></td>
      </tr>`;
      htmlContent += `<tr class="total-row" style="background: #007acc !important; color: white;">
        <td colspan="11"><strong>GENEL TOPLAM</strong></td>
        <td class="number"><strong>${grandTotal.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</strong></td>
      </tr>`;

    } else if (reportType === 'quoteReport') {
      // Teklif raporu için istatistik kutusu - MCP test sayfasındaki gerçek alan adları
      const totalQuotes = data.length;
      const activeQuotes = data.filter(row => row['TeklifDurumu'] !== 'İptal').length;
      const totalAmount = data.reduce((sum, row) => sum + (parseFloat(row['GenelToplam']) || 0), 0);

      htmlContent += `
        <div class="stats-box">
          <div class="stats-title">📋 Teklif Özeti</div>
          <div><strong>Toplam Teklif:</strong> ${totalQuotes}</div>
          <div><strong>Aktif Teklif:</strong> ${activeQuotes}</div>
          <div><strong>Toplam Tutar:</strong> ${totalAmount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</div>
        </div>
      `;

      // Teklif raporu için format - MCP test sayfasındaki tüm kolonlar
      htmlContent += `<table><thead><tr>
        <th>Teklif No</th>
        <th>Teklif Tarihi</th>
        <th>Cari Ünvan</th>
        <th>Teklif Durumu</th>
        <th>Teklif Açıklaması</th>
        <th>Teklif İskonto Oranı</th>
        <th>Genel Toplam</th>
        <th>Para Birimi</th>
        <th>Kayıt Kullanıcısı</th>
        <th>Son Değiştirme Tarihi</th>
      </tr></thead><tbody>`;

      data.forEach((row) => {
        const teklifNo = row['TeklifNo'] || 'N/A';
        const teklifTarihi = row['TeklifTarihi'] ? new Date(row['TeklifTarihi']).toLocaleDateString('tr-TR') : 'N/A';
        const cariUnvan = row['CariUnvan'] || 'N/A';
        const teklifDurumu = row['TeklifDurumu'] || 'N/A';
        const teklifAciklamasi = row['TeklifAciklamasi'] || 'N/A';
        const teklifIskontoOrani = row['TeklifIskontoOrani'] || 0;
        const genelToplam = parseFloat(row['GenelToplam']) || 0;
        const paraBirimi = row['ParaBirimi'] || 'TL';
        const kayitKullanicisi = row['KaydedenKullanici'] || 'N/A';
        const sonDegistirmeTarihi = row['SonDegistirmeTarihi'] ? new Date(row['SonDegistirmeTarihi']).toLocaleDateString('tr-TR') : 'N/A';

        htmlContent += `<tr>
          <td style="font-weight: bold; color: #007acc;">${teklifNo}</td>
          <td>${teklifTarihi}</td>
          <td style="max-width: 150px; word-wrap: break-word;">${cariUnvan}</td>
          <td><span style="padding: 2px 6px; border-radius: 3px; background: ${teklifDurumu === 'Teklifte' ? '#e3f2fd' : '#f5f5f5'};">${teklifDurumu}</span></td>
          <td style="max-width: 120px; word-wrap: break-word;">${teklifAciklamasi}</td>
          <td class="number">${parseFloat(teklifIskontoOrani).toFixed(1)}%</td>
          <td class="number" style="font-weight: bold; color: #2e7d32;">${genelToplam.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</td>
          <td style="text-align: center;">${paraBirimi}</td>
          <td>${kayitKullanicisi}</td>
          <td>${sonDegistirmeTarihi}</td>
        </tr>`;
      });

      // Toplam satırı
      htmlContent += `<tr class="total-row">
        <td colspan="6"><strong>TOPLAM</strong></td>
        <td class="number"><strong>${totalAmount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</strong></td>
        <td><strong>TL</strong></td>
        <td colspan="2"></td>
      </tr>`;

    } else if (reportType === 'customerMovement') {
      // Cari hareket raporu için istatistik kutusu
      const totalMovements = data.length;
      let totalDebit = 0;
      let totalCredit = 0;
      let finalBalance = 0;

      data.forEach(row => {
        totalDebit += parseFloat(row['BorcTutari']) || 0;
        totalCredit += parseFloat(row['AlacakTutari']) || 0;
      });

      if (data.length > 0) {
        finalBalance = parseFloat(data[data.length - 1]['SatirBakiyesi']) || 0;
      }

      htmlContent += `
        <div class="stats-box">
          <div class="stats-title">📈 Hareket Özeti</div>
          <div><strong>Toplam Hareket:</strong> ${totalMovements}</div>
          <div><strong>Toplam Borç:</strong> ${totalDebit.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</div>
          <div><strong>Toplam Alacak:</strong> ${totalCredit.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</div>
          <div><strong>Güncel Bakiye:</strong> ${finalBalance.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</div>
        </div>
      `;

      // Cari hareket tablosu - MCP-TEST sayfasındaki alan adları
      htmlContent += `<table><thead><tr>
        <th>İşlem Tarihi</th>
        <th>Belge No</th>
        <th>Açıklama</th>
        <th>İşlem Türü</th>
        <th>Para Birimi</th>
        <th>Borç Tutarı</th>
        <th>Alacak Tutarı</th>
        <th>Satır Bakiyesi</th>
      </tr></thead><tbody>`;

      data.forEach((row) => {
        const islemTarihi = row['IslemTarihi'] || 'N/A';
        const belgeNo = row['BelgeNo'] || 'N/A';
        const aciklama = row['Aciklama'] || 'N/A';
        const islemTuru = row['IslemTuru'] || 'N/A';
        const paraBirimi = row['ParaBirimi'] || 'TL';
        const borcTutari = parseFloat(row['BorcTutari']) || 0;
        const alacakTutari = parseFloat(row['AlacakTutari']) || 0;
        const satirBakiyesi = parseFloat(row['SatirBakiyesi']) || 0;

        htmlContent += `<tr>
          <td>${islemTarihi}</td>
          <td style="font-weight: bold; color: #007acc;">${belgeNo}</td>
          <td style="max-width: 200px; word-wrap: break-word;">${aciklama}</td>
          <td>${islemTuru}</td>
          <td style="text-align: center;">${paraBirimi}</td>
          <td class="number" style="color: ${borcTutari > 0 ? '#d32f2f' : '#666'};">${borcTutari > 0 ? borcTutari.toLocaleString('tr-TR', { minimumFractionDigits: 2 }) : '-'}</td>
          <td class="number" style="color: ${alacakTutari > 0 ? '#2e7d32' : '#666'};">${alacakTutari > 0 ? alacakTutari.toLocaleString('tr-TR', { minimumFractionDigits: 2 }) : '-'}</td>
          <td class="number" style="font-weight: bold; color: ${satirBakiyesi >= 0 ? '#2e7d32' : '#d32f2f'};">${satirBakiyesi.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</td>
        </tr>`;
      });

      // Toplam satırları
      htmlContent += `<tr class="total-row">
        <td colspan="5"><strong>TOPLAM</strong></td>
        <td class="number"><strong>${totalDebit.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</strong></td>
        <td class="number"><strong>${totalCredit.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</strong></td>
        <td class="number"><strong>${finalBalance.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</strong></td>
      </tr>`;

    } else {
      // Genel format (diğer rapor türleri için) - MCP-TEST sayfasındaki alan adlarını kullan
      if (data.length > 0) {
        const columns = Object.keys(data[0]);

        htmlContent += `<table><thead><tr>`;
        columns.forEach(col => {
          htmlContent += `<th>${col}</th>`;
        });
        htmlContent += `</tr></thead><tbody>`;

        data.forEach((row) => {
          htmlContent += `<tr>`;
          columns.forEach(col => {
            const value = row[col] || '';
            const isNumber = !isNaN(parseFloat(value)) && isFinite(value) && value !== '';
            const displayValue = isNumber ? parseFloat(value).toLocaleString('tr-TR', { minimumFractionDigits: 2 }) : value;
            htmlContent += `<td${isNumber ? ' class="number"' : ''}>${displayValue}</td>`;
          });
          htmlContent += `</tr>`;
        });
      }
    }

    htmlContent += `</tbody></table>
        <div class="footer">
            Bu rapor TAR-S ERP ZEK sistemi tarafından otomatik olarak oluşturulmuştur.<br>
            © ${new Date().getFullYear()} TAR-S - Tüm hakları saklıdır.
        </div>
    </body>
    </html>`;

    // PDF oluştur
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: pageSize as any,
      landscape: orientation === 'landscape',
      margin: {
        top: '15mm',
        right: '10mm',
        bottom: '15mm',
        left: '10mm'
      },
      printBackground: true
    });

    await browser.close();

    // PDF dosyasını kaydet - Türkçe isim + İstanbul saati
    const istanbulTime = new Date().toLocaleString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).replace(/[.:\/\s]/g, '').replace(',', '-');

    // Rapor türüne göre Türkçe dosya adı
    let turkishFileName = '';
    switch (reportType) {
      case 'bankBalances':
        turkishFileName = 'Banka_Bakiye_Listesi';
        break;
      case 'stockReport':
        turkishFileName = 'Stok_Durumu_Raporu';
        break;
      case 'customerInfo':
        turkishFileName = 'Cari_Hesap_Bilgileri';
        break;
      case 'quoteReport':
        turkishFileName = 'Teklif_Raporu';
        break;
      case 'quoteDetail':
        turkishFileName = 'Teklif_Detayi';
        break;
      default:
        turkishFileName = 'ERP_Raporu';
    }

    const fileName = `${turkishFileName}_${istanbulTime}.pdf`;
    const filePath = path.join(process.cwd(), 'temp', fileName);

    // Temp klasörü yoksa oluştur
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fs.writeFileSync(filePath, pdfBuffer);

    return filePath;

  } catch (error) {
    console.error('PDF oluşturma hatası:', error);
    throw new Error(`PDF oluşturulamadı: ${error}`);
  }
}

// Fonksiyon çağrılarını işle
async function handleFunctionCall(functionName: string, args: any, userId?: number): Promise<string> {
  try {
    // İzin kontrolü
    if (userId && !hasPermission(userId, functionName)) {
      return `❌ Bu fonksiyon (${functionName}) için yetkiniz yok.`;
    }

    // Kullanım istatistiklerini güncelle
    if (userId) {
      updateUsageStats(userId, functionName);
    }

    switch (functionName) {
      case 'getBankBalances':
        const bankParams: any = {};
        if (args.bankName) bankParams.banka_adi = args.bankName;
        if (args.para_birimi) bankParams.para_birimi = args.para_birimi;
        const bankResult = await executeMCPQuery('banka_bakiyeleri', bankParams);

        if (bankResult.success && bankResult.data) {
          // Eğer belirli bir banka aranıyorsa, client-side filtreleme yap
          let filteredData = bankResult.data;
          if (args.bankName) {
            const searchTerm = normalizeTurkish(args.bankName);

            // Debug: Mevcut banka adlarını logla
            console.log(`🔍 Aranan banka (normalize): "${searchTerm}"`);
            console.log(`📊 Mevcut banka adları:`, bankResult.data.map((row: any) => row['Banka Adı'] || 'BOŞ'));

            filteredData = bankResult.data.filter((row: any) => {
              const bankName = normalizeTurkish(row['Banka Adı'] || '');
              const matches = bankName.includes(searchTerm);
              console.log(`🔍 "${bankName}" contains "${searchTerm}"? ${matches}`);
              return matches;
            });

            if (filteredData.length === 0) {
              return `❌ **"${args.bankName}"** bankasında hesap bulunamadı.\n\n💡 **Öneriler:**\n• Banka adını kontrol edin\n• Kısaltma kullanmayı deneyin (örn: "Garanti")\n• Tüm bankalar için "banka bakiyelerim" deyin`;
            }
          }

          // Kullanıcı verilerini sakla
          if (userId) {
            userPreferences[userId] = {
              preferText: false,
              lastDataType: 'bankBalances',
              lastData: filteredData,
              lastQuery: 'banka_bakiyeleri',
              lastTitle: 'Banka Bakiye Raporu'
            };
          }

          // Debug: Veriyi logla
          console.log(`🔍 Banka sorgusu sonucu: ${filteredData.length} kayıt`);
          console.log(`📊 İlk kayıt örneği:`, filteredData[0]);

          // Büyük veri kontrolü - 10'dan fazla kayıt varsa PDF oluştur
          if (filteredData.length > 10 && userId) {
            // PDF oluştur ve gönder
            setTimeout(async () => {
              try {
                const pdfPath = await generatePDF(filteredData, 'bankBalances', 'Banka Bakiye Raporu');
                await bot.sendDocument(userId, pdfPath, {
                  caption: `📊 **Banka Bakiye Raporu**\n\n✅ ${filteredData.length} hesap\n📅 ${new Date().toLocaleDateString('tr-TR')}`
                });
                // Dosyayı sil
                setTimeout(() => {
                  if (fs.existsSync(pdfPath)) {
                    fs.unlinkSync(pdfPath);
                  }
                }, 5000);
              } catch (pdfError) {
                console.error('PDF oluşturma hatası:', pdfError);
              }
            }, 500);
          }

          return formatBankBalances(filteredData, userId?.toString());
        } else {
          return `❌ **Banka bakiye verilerini alamadım.**\n\n🔧 **Hata:** ${bankResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getGeneralBalanceTotal':
        const generalBalanceResult = await executeMCPQuery('bakiyeler_listesi', {});

        if (generalBalanceResult.success && generalBalanceResult.data) {
          return formatGeneralBalanceTotal(generalBalanceResult.data);
        } else {
          return `❌ **Genel bakiye toplamını alamadım.**\n\n🔧 **Hata:** ${generalBalanceResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getReceivableBalanceList':
        const receivableResult = await executeMCPQuery('bakiyeler_listesi', { bakiye_durumu_filtresi: 'alacakli' });

        if (receivableResult.success && receivableResult.data) {
          return formatReceivableBalanceList(receivableResult.data);
        } else {
          return `❌ **Alacaklı bakiye listesini alamadım.**\n\n🔧 **Hata:** ${receivableResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getDebtorBalanceList':
        console.error('🔧 DEBUG - getDebtorBalanceList çağrıldı');
        const debtorResult = await executeMCPQuery('bakiyeler_listesi', { bakiye_durumu_filtresi: 'borclu' });
        console.error('🔧 DEBUG - MCP sonucu:', { success: debtorResult.success, dataLength: debtorResult.data?.length, error: debtorResult.error });

        if (debtorResult.success && debtorResult.data) {
          console.error('🔧 DEBUG - formatDebtorBalanceList çağrılıyor...');
          return formatDebtorBalanceList(debtorResult.data);
        } else {
          console.error('🔧 DEBUG - MCP hatası:', debtorResult.error);
          return `❌ **Borçlu bakiye listesini alamadım.**\n\n🔧 **Hata:** ${debtorResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getStockReport':
        const stockParams: any = {};
        if (args.productName) stockParams.urun_adi = args.productName;
        if (args.depo_adi) stockParams.depo_adi = args.depo_adi;
        const stockResult = await executeMCPQuery('stok_raporu', stockParams);

        if (stockResult.success && stockResult.data) {
          // Kullanıcı verilerini sakla
          if (userId) {
            userPreferences[userId] = {
              preferText: false,
              lastDataType: 'stockReport',
              lastData: stockResult.data,
              lastQuery: 'stok_raporu',
              lastTitle: 'Stok Durumu Raporu'
            };
          }

          // Büyük veri kontrolü - 15'ten fazla ürün varsa PDF oluştur
          if (stockResult.data.length > 15 && userId) {
            // PDF oluştur ve gönder
            setTimeout(async () => {
              try {
                const pdfPath = await generatePDF(stockResult.data, 'stockReport', 'Stok Durumu Raporu');
                await bot.sendDocument(userId, pdfPath, {
                  caption: `📦 **Stok Durumu Raporu**\n\n✅ ${stockResult.data.length} ürün\n📅 ${new Date().toLocaleDateString('tr-TR')}`
                });
                // Dosyayı sil
                setTimeout(() => {
                  if (fs.existsSync(pdfPath)) {
                    fs.unlinkSync(pdfPath);
                  }
                }, 5000);
              } catch (pdfError) {
                console.error('PDF oluşturma hatası:', pdfError);
              }
            }, 500);
          }

          return formatStockReport(stockResult.data, userId?.toString());
        } else {
          return `Stok raporunu alamadım. Hata: ${stockResult.error || 'Bilinmeyen sorun'}`;
        }

      case 'getCustomerInfo':
        const customerParams = args.customerName ? { cari_unvani: args.customerName } : {};
        const customerResult = await executeMCPQuery('cari_bilgi', customerParams);

        if (customerResult.success && customerResult.data && customerResult.data.length > 0) {
          // Eğer belirli bir firma aranıyorsa, client-side filtreleme yap
          let filteredData = customerResult.data;
          if (args.customerName) {
            const searchTerm = normalizeTurkish(args.customerName);
            filteredData = customerResult.data.filter((row: any) => {
              const customerName = normalizeTurkish(row['CariUnvan'] || '');
              return customerName.includes(searchTerm);
            });

            if (filteredData.length === 0) {
              // Benzer firmaları ara
              const matchingResult = await findMatchingCustomers(args.customerName);

              if (matchingResult.suggestions.length > 0) {
                let response = `❌ **"${args.customerName}"** adında cari bulunamadı.\n\n`;
                response += `🔍 **Benzer firmalar buldum:**\n`;
                matchingResult.suggestions.forEach((suggestion, index) => {
                  response += `${index + 1}. ${suggestion}\n`;
                });
                response += `\n💡 **Hangi firmayı kastediyorsunuz?** Tam adını yazabilirsiniz.`;
                return response;
              } else {
                return `❌ **"${args.customerName}"** adında cari bulunamadı.\n\n💡 **Öneriler:**\n• Firma adını kontrol edin\n• Kısaltma kullanmayı deneyin\n• Tüm cariler için "cari bilgileri" deyin`;
              }
            }
          }

          // Kullanıcı verilerini sakla
          if (userId) {
            userPreferences[userId] = {
              preferText: false,
              lastDataType: 'customerInfo',
              lastData: filteredData,
              lastQuery: 'cari_bilgi',
              lastTitle: 'Cari Hesap Bilgileri'
            };
          }

          // Büyük veri kontrolü - 10'dan fazla cari varsa PDF oluştur
          if (filteredData.length > 10 && userId) {
            // PDF oluştur ve gönder
            setTimeout(async () => {
              try {
                const pdfPath = await generatePDF(filteredData, 'customerInfo', 'Cari Hesap Bilgileri');
                await bot.sendDocument(userId, pdfPath, {
                  caption: `👥 **Cari Hesap Bilgileri**\n\n✅ ${filteredData.length} cari\n📅 ${new Date().toLocaleDateString('tr-TR')}`
                });
                // Dosyayı sil
                setTimeout(() => {
                  if (fs.existsSync(pdfPath)) {
                    fs.unlinkSync(pdfPath);
                  }
                }, 5000);
              } catch (pdfError) {
                console.error('PDF oluşturma hatası:', pdfError);
              }
            }, 500);
          }

          return formatCustomerInfo(filteredData);
        } else {
          return `❌ **Cari hesap bilgilerini alamadım.**\n\n🔧 **Hata:** ${customerResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getCreditCardLimits':
        const creditCardResult = await executeMCPQuery('kredi_karti_limitleri');

        if (creditCardResult.success && creditCardResult.data) {
          // Kullanıcı verilerini sakla
          if (userId) {
            userPreferences[userId] = {
              preferText: false,
              lastDataType: 'creditCardLimits',
              lastData: creditCardResult.data,
              lastQuery: 'kredi_karti_limitleri',
              lastTitle: 'Kredi Kartı Limit Raporu'
            };
          }

          return formatCreditCardLimits(creditCardResult.data);
        } else {
          return `❌ **Kredi kartı limit bilgilerini alamadım.**\n\n🔧 **Hata:** ${creditCardResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getForeignCurrencyAccounts':
        const foreignCurrencyResult = await executeMCPQuery('doviz_hesaplari_tl_karsiligi');

        if (foreignCurrencyResult.success && foreignCurrencyResult.data) {
          return formatForeignCurrencyAccounts(foreignCurrencyResult.data);
        } else {
          return `Döviz hesap bilgilerini alamadım. Hata: ${foreignCurrencyResult.error || 'Bilinmeyen sorun'}`;
        }

      case 'getOwnChecks':
        const checksReportType = args.reportType || 'ozet';
        const checksQueryName = checksReportType === 'detay' ? 'kendi_ceklerimiz_detay' : 'kendi_ceklerimiz_ozet';
        const checksResult = await executeMCPQuery(checksQueryName);

        if (checksResult.success && checksResult.data) {
          return formatOwnChecks(checksResult.data, checksReportType);
        } else {
          return `Çek/senet bilgilerini alamadım. Hata: ${checksResult.error || 'Bilinmeyen sorun'}`;
        }



      case 'getBalanceList':
        if (!userId || !hasPermission(userId, 'getBalanceList')) {
          return '❌ Bu fonksiyon için yetkiniz yok.';
        }

        const balanceParams: any = {};
        if (args.groupFilter) balanceParams.grup_filtresi = args.groupFilter;
        if (args.companyNameFilter) balanceParams.ticari_unvan_filtresi = args.companyNameFilter;
        if (args.balanceStatusFilter) balanceParams.bakiye_durumu_filtresi = args.balanceStatusFilter;

        const balanceListResult = await executeMCPQuery('bakiyeler_listesi', balanceParams);

        if (balanceListResult.success && balanceListResult.data) {
          // Kullanıcı verilerini sakla
          if (userId) {
            userPreferences[userId] = {
              preferText: false,
              lastDataType: 'balanceList',
              lastData: balanceListResult.data,
              lastQuery: 'bakiyeler_listesi',
              lastTitle: 'Parametreli Bakiyeler Listesi'
            };
          }

          return formatBalanceList(balanceListResult.data, args, userId, 'Parametreli Bakiyeler Listesi');
        } else {
          return `❌ **Bakiyeler listesi bilgilerini alamadım.**\n\n🔧 **Hata:** ${balanceListResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getCashBalance':
        const cashResult = await executeMCPQuery('kasa_bakiye_detay');

        if (cashResult.success && cashResult.data) {
          return formatCashBalance(cashResult.data);
        } else {
          return `Kasa bakiye bilgilerini alamadım. Hata: ${cashResult.error || 'Bilinmeyen sorun'}`;
        }

      case 'getQuoteReport':
        const quoteParams: any = {};
        if (args.customerName) quoteParams.cari_unvani = args.customerName;
        if (args.quoteStatus) quoteParams.teklif_durumu = args.quoteStatus;

        const quoteResult = await executeMCPQuery('teklif_raporu', quoteParams);

        if (quoteResult.success && quoteResult.data) {
          // Eğer belirli bir firma aranıyorsa ve sonuç yoksa, benzer firmaları ara
          if (args.customerName && quoteResult.data.length === 0) {
            const matchingResult = await findMatchingCustomers(args.customerName);

            if (matchingResult.suggestions.length > 0) {
              let response = `❌ **"${args.customerName}"** firmasına ait teklif bulunamadı.\n\n`;
              response += `🔍 **Benzer firmalar buldum:**\n`;
              matchingResult.suggestions.forEach((suggestion, index) => {
                response += `${index + 1}. ${suggestion}\n`;
              });
              response += `\n💡 **Bu firmalardan birinin tekliflerini mi arıyorsunuz?** Tam adını yazabilirsiniz.`;
              return response;
            } else {
              return `❌ **"${args.customerName}"** firmasına ait teklif bulunamadı.\n\n💡 **Öneriler:**\n• Firma adını kontrol edin\n• Tüm teklifler için "teklif raporu" deyin`;
            }
          }

          // Firma adı belirtilmişse SADECE PDF gönder
          if (args.customerName) {
            // PDF oluştur ve gönder
            setTimeout(async () => {
              try {
                const pdfPath = await generatePDF(quoteResult.data, 'quoteReport', `${args.customerName} Firma Teklifleri`);
                await bot.sendDocument(userId, pdfPath, {
                  caption: `📋 **${args.customerName} Firma Teklifleri**\n\n✅ ${quoteResult.data.length} teklif\n📅 ${new Date().toLocaleDateString('tr-TR')}`
                });
                // Dosyayı sil
                setTimeout(() => {
                  if (fs.existsSync(pdfPath)) {
                    fs.unlinkSync(pdfPath);
                  }
                }, 5000);
              } catch (pdfError) {
                console.error('PDF oluşturma hatası:', pdfError);
              }
            }, 500);

            return `📋 **${args.customerName} firmasına verilen teklifler PDF olarak gönderiliyor...**\n\n📊 **Toplam:** ${quoteResult.data.length} teklif bulundu`;
          }

          // Genel teklif raporu - 5'ten fazla varsa PDF
          if (quoteResult.data.length > 5) {
            // PDF oluştur ve gönder
            setTimeout(async () => {
              try {
                const pdfPath = await generatePDF(quoteResult.data, 'quoteReport', 'Teklif Raporu');
                await bot.sendDocument(userId, pdfPath, {
                  caption: `📋 **Teklif Raporu**\n\n✅ ${quoteResult.data.length} teklif\n📅 ${new Date().toLocaleDateString('tr-TR')}`
                });
                // Dosyayı sil
                setTimeout(() => {
                  if (fs.existsSync(pdfPath)) {
                    fs.unlinkSync(pdfPath);
                  }
                }, 5000);
              } catch (pdfError) {
                console.error('PDF oluşturma hatası:', pdfError);
              }
            }, 500);
          }

          return formatQuoteReport(quoteResult.data);
        } else {
          return `❌ **Teklif bilgilerini alamadım.**\n\n🔧 **Hata:** ${quoteResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getCustomerMovement':
        const movementParams: any = {};
        if (args.customerName) movementParams.cari_unvani = args.customerName;
        if (args.startDate) movementParams.baslangic_tarihi = args.startDate;
        if (args.endDate) movementParams.bitis_tarihi = args.endDate;

        const movementResult = await executeMCPQuery('cari_hareket', movementParams);

        if (movementResult.success && movementResult.data) {
          // Eğer belirli bir firma aranıyorsa ve sonuç yoksa, benzer firmaları ara
          if (args.customerName && movementResult.data.length === 0) {
            const matchingResult = await findMatchingCustomers(args.customerName);

            if (matchingResult.suggestions.length > 0) {
              // İlk önerilen firma ile otomatik deneme yap
              const firstSuggestion = matchingResult.suggestions[0];
              console.log(`🔄 Otomatik düzeltme: "${args.customerName}" → "${firstSuggestion}"`);

              const retryParams = { ...movementParams };
              retryParams.cari_unvani = firstSuggestion;

              const retryResult = await executeMCPQuery('cari_hareket', retryParams);

              if (retryResult.success && retryResult.data && retryResult.data.length > 0) {
                // Başarılı! Düzeltilmiş isimle veri bulundu
                console.log(`✅ Otomatik düzeltme başarılı: ${retryResult.data.length} hareket bulundu`);

                // Kullanıcı verilerini sakla
                if (userId) {
                  userPreferences[userId] = {
                    preferText: false,
                    lastDataType: 'customerMovement',
                    lastData: retryResult.data,
                    lastQuery: 'cari_hareket',
                    lastTitle: `${firstSuggestion} Hareket Raporu`
                  };
                }

                // Önce özet metin oluştur
                const movementSummary = formatCustomerMovementSummary(retryResult.data, firstSuggestion);
                let response = `🔄 **Otomatik düzeltme:** "${args.customerName}" → "${firstSuggestion}"\n\n` + movementSummary;

                // PDF'i arka planda oluştur ve gönder
                if (userId) {
                  setTimeout(async () => {
                    try {
                      const pdfPath = await generatePDF(retryResult.data, 'customerMovement', `${firstSuggestion} Hareket Raporu`);
                      await bot.sendDocument(userId, pdfPath, {
                        caption: `📈 **${firstSuggestion} Hareket Raporu PDF**\n\n✅ ${retryResult.data.length} hareket kaydı\n📅 ${new Date().toLocaleDateString('tr-TR')}`
                      });
                      setTimeout(() => {
                        if (fs.existsSync(pdfPath)) {
                          fs.unlinkSync(pdfPath);
                        }
                      }, 5000);
                    } catch (pdfError) {
                      console.error('PDF oluşturma hatası:', pdfError);
                      bot.sendMessage(userId, '❌ PDF oluşturulamadı, ancak hareket özeti yukarıda gösterildi.');
                    }
                  }, 500);
                }

                return response;
              } else {
                // Otomatik düzeltme de başarısız, önerileri göster
                let response = `❌ **"${args.customerName}"** firmasına ait hareket bulunamadı.\n\n`;
                response += `🔍 **Benzer firmalar buldum:**\n`;
                matchingResult.suggestions.forEach((suggestion, index) => {
                  response += `${index + 1}. ${suggestion}\n`;
                });
                response += `\n💡 **Bu firmalardan birinin hareketlerini mi arıyorsunuz?** Tam adını yazabilirsiniz.`;
                return response;
              }
            } else {
              return `❌ **"${args.customerName}"** firmasına ait hareket bulunamadı.\n\n💡 **Öneriler:**\n• Firma adını kontrol edin\n• Tarih aralığını genişletin\n• Tüm hareketler için "cari hareket" deyin`;
            }
          }

          // Kullanıcı verilerini sakla
          if (userId) {
            userPreferences[userId] = {
              preferText: false,
              lastDataType: 'customerMovement',
              lastData: movementResult.data,
              lastQuery: 'cari_hareket',
              lastTitle: `${args.customerName || 'Tüm Cariler'} Hareket Raporu`
            };
          }

          // Önce özet metin oluştur
          const movementSummary = formatCustomerMovementSummary(movementResult.data, args.customerName);

          // PDF'i arka planda oluştur ve gönder
          setTimeout(async () => {
            try {
              const pdfPath = await generatePDF(movementResult.data, 'customerMovement', `${args.customerName || 'Tüm Cariler'} Hareket Raporu`);

              await bot.sendDocument(userId, pdfPath, {
                caption: `📈 **${args.customerName || 'Tüm Cariler'} Hareket Raporu PDF**\n\n✅ ${movementResult.data.length} hareket kaydı\n📅 ${new Date().toLocaleDateString('tr-TR')}`
              });

              // Dosyayı sil
              setTimeout(() => {
                if (fs.existsSync(pdfPath)) {
                  fs.unlinkSync(pdfPath);
                }
              }, 5000);
            } catch (pdfError) {
              console.error('PDF oluşturma hatası:', pdfError);
              bot.sendMessage(userId, '❌ PDF oluşturulamadı, ancak hareket özeti yukarıda gösterildi.');
            }
          }, 500);

          return movementSummary;
        } else {
          return `❌ **Cari hareket bilgilerini alamadım.**\n\n🔧 **Hata:** ${movementResult.error || 'Bilinmeyen sorun'}\n\n💡 **Çözüm:** Lütfen daha sonra tekrar deneyin.`;
        }

      case 'getAdvancedAnalytics':
        return await handleAdvancedAnalytics(args.analysisType, userId);

      case 'getFinancialInsights':
        return await handleFinancialInsights(userId);

      case 'testConnection':
        const testResult = await executeMCPQuery('test_baglanti');

        if (testResult.success) {
          return `✅ Sistem çalışıyor! Veritabanında ${testResult.recordCount} tablo bulundu. Her şey yolunda görünüyor.`;
        } else {
          return `❌ Sistemde sorun var: ${testResult.error}`;
        }

      case 'handlePDFRequest':
        if (!userId) {
          return '❌ PDF oluşturmak için kullanıcı bilgisi gerekli.';
        }
        return await handlePDFRequest(userId);

      case 'getQuoteDetail':
        if (!userId || !hasPermission(userId, 'getQuoteDetail')) {
          return '❌ Bu fonksiyon için yetkiniz yok.';
        }

        if (!args.quoteNumber) {
          return '❌ **Teklif numarası belirtilmedi.**\n\n💡 **Örnek:** "TEK-2023-1050 teklifini aç"';
        }

        const quoteDetailResult = await executeMCPQuery('teklif_detay', { teklif_no: args.quoteNumber });

        if (quoteDetailResult.success && quoteDetailResult.data && quoteDetailResult.data.length > 0) {
          // Kullanıcı verilerini sakla
          if (userId) {
            userPreferences[userId] = {
              preferText: false,
              lastDataType: 'quoteDetail',
              lastData: quoteDetailResult.data,
              lastQuery: 'teklif_detay',
              lastTitle: `Teklif Detayı - ${args.quoteNumber}`
            };
          }

          // Hızlı teklif detayı formatı + PDF oluştur
          const quickSummary = formatQuoteDetailQuick(quoteDetailResult.data, args.quoteNumber);

          // PDF'i arka planda oluştur ve gönder
          setTimeout(async () => {
            try {
              const pdfPath = await generatePDF(quoteDetailResult.data, 'quoteDetail', `Teklif Detayı - ${args.quoteNumber}`);

              await bot.sendDocument(userId, pdfPath, {
                caption: `📋 **${args.quoteNumber} Teklif Detayı PDF**\n\n✅ ${quoteDetailResult.data.length} kalem ürün\n📅 ${new Date().toLocaleDateString('tr-TR')}`
              }, {
                contentType: 'application/pdf',
                filename: `Teklif_${args.quoteNumber}_${new Date().toISOString().split('T')[0]}.pdf`
              });

              // Dosyayı sil
              setTimeout(() => {
                if (fs.existsSync(pdfPath)) {
                  fs.unlinkSync(pdfPath);
                }
              }, 5000);
            } catch (pdfError) {
              console.error('PDF oluşturma hatası:', pdfError);
              bot.sendMessage(userId, '❌ PDF oluşturulamadı, ancak teklif detayları yukarıda gösterildi.');
            }
          }, 500);

          return quickSummary;
        } else {
          // Benzer teklifleri ara
          const matchingResult = await findMatchingQuotes(args.quoteNumber);

          if (matchingResult.suggestions.length > 0) {
            let response = `❌ **"${args.quoteNumber}"** numaralı teklif bulunamadı.\n\n`;
            response += `🔍 **Benzer teklifler buldum:**\n`;
            matchingResult.suggestions.forEach((suggestion, index) => {
              response += `${index + 1}. ${suggestion}\n`;
            });
            response += `\n💡 **Bu tekliflerden birini mi arıyorsunuz?** Tam numarasını yazabilirsiniz.`;
            return response;
          } else {
            return `❌ **"${args.quoteNumber}"** numaralı teklif bulunamadı.\n\n💡 **Öneriler:**\n• Teklif numarasını kontrol edin\n• Tüm teklifler için "teklif raporu" deyin`;
          }
        }

      case 'generatePDF':
        const pdfReportType = args.reportType || 'bankBalances';
        const title = args.title || 'ERP Raporu';

        let pdfData: any[] = [];

        if (pdfReportType === 'bankBalances') {
          const bankResult = await executeMCPQuery('banka_bakiyeleri');
          if (bankResult.success && bankResult.data) {
            pdfData = bankResult.data;
          } else {
            return `❌ PDF için banka verisi alınamadı: ${bankResult.error}`;
          }
        } else if (pdfReportType === 'stockReport') {
          const stockResult = await executeMCPQuery('stok_raporu');
          if (stockResult.success && stockResult.data) {
            pdfData = stockResult.data;
          } else {
            return `❌ PDF için stok verisi alınamadı: ${stockResult.error}`;
          }
        }

        try {
          const pdfPath = await generatePDF(pdfData, pdfReportType, title);

          // PDF'i Telegram'da gönder
          if (userId) {
            try {
              await bot.sendDocument(userId, pdfPath, {
                caption: `📄 ${title}\n\n✅ PDF raporu başarıyla oluşturuldu!\n📅 Tarih: ${new Date().toLocaleDateString('tr-TR')}`
              });

              // Dosyayı sil (güvenlik için)
              setTimeout(() => {
                if (fs.existsSync(pdfPath)) {
                  fs.unlinkSync(pdfPath);
                }
              }, 5000);

              return `✅ PDF raporu başarıyla oluşturuldu ve size gönderildi! 📄`;
            } catch (telegramError) {
              console.error('Telegram PDF gönderme hatası:', telegramError);
              return `✅ PDF oluşturuldu ancak gönderilirken hata oluştu. Dosya yolu: ${pdfPath}`;
            }
          }

          return `✅ PDF başarıyla oluşturuldu! Dosya yolu: ${pdfPath}`;
        } catch (error) {
          return `❌ PDF oluşturulamadı: ${error}`;
        }

      default:
        return `Bu fonksiyonu tanımıyorum: ${functionName}`;
    }
  } catch (error) {
    return `Bir hata oluştu: ${error}`;
  }
}

// Gelişmiş analitik fonksiyonu
async function handleAdvancedAnalytics(analysisType: string, userId?: number): Promise<string> {
  try {
    let analysisResult = '';

    switch (analysisType) {
      case 'financial':
        // Finansal analiz - Banka bakiyeleri ve kredi kartı limitleri
        const bankResult = await executeMCPQuery('banka_bakiyeleri');
        const creditResult = await executeMCPQuery('kredi_karti_limitleri');
        const foreignResult = await executeMCPQuery('doviz_hesaplari_tl_karsiligi');

        if (bankResult.success && creditResult.success) {
          const bankData = bankResult.data || [];
          const creditData = creditResult.data || [];
          const foreignData = foreignResult.data || [];

          // Finansal analiz hesaplamaları
          let totalTLBalance = 0;
          let totalForeignBalance = 0;
          let bankCount = 0;

          bankData.forEach((row: any) => {
            if (!row['Banka Adı']?.includes('TOPLAM')) {
              const balance = parseFloat(row['Bakiye']) || 0;
              if (row['Para Birimi'] === 'TL') {
                totalTLBalance += balance;
              }
              bankCount++;
            }
          });

          foreignData.forEach((row: any) => {
            if (!row['BankaAdi']?.includes('TOPLAM')) {
              totalForeignBalance += parseFloat(row['BakiyeTL_Karsiligi_Gosterilecek']) || 0;
            }
          });

          const totalCreditLimit = creditData.reduce((sum: number, row: any) => {
            if (row['TANIM'] === 'TOPLAM :') {
              return sum + (parseFloat(row['KK TOP LİMİTLER']) || 0);
            }
            return sum;
          }, 0);

          const availableCreditLimit = creditData.reduce((sum: number, row: any) => {
            if (row['TANIM'] === 'TOPLAM :') {
              return sum + (parseFloat(row['KK KULLANILABİLİR LİMİTLER']) || 0);
            }
            return sum;
          }, 0);

          analysisResult = `📊 **Gelişmiş Finansal Analiz**\n\n`;
          analysisResult += `💰 **Likidite Durumu:**\n`;
          analysisResult += `• TL Bakiye: ${formatNumber(totalTLBalance)} TL\n`;
          analysisResult += `• Döviz Bakiye (TL): ${formatNumber(totalForeignBalance)} TL\n`;
          analysisResult += `• Toplam Likidite: ${formatNumber(totalTLBalance + totalForeignBalance)} TL\n\n`;

          analysisResult += `💳 **Kredi Kapasitesi:**\n`;
          analysisResult += `• Toplam KK Limit: ${formatNumber(totalCreditLimit)} TL\n`;
          analysisResult += `• Kullanılabilir Limit: ${formatNumber(availableCreditLimit)} TL\n`;
          analysisResult += `• Kullanım Oranı: %${((totalCreditLimit - availableCreditLimit) / totalCreditLimit * 100).toFixed(1)}\n\n`;

          analysisResult += `📈 **Finansal Öngörüler:**\n`;
          if (totalTLBalance + totalForeignBalance > 1000000) {
            analysisResult += `• ✅ Güçlü likidite pozisyonu\n`;
          } else if (totalTLBalance + totalForeignBalance > 500000) {
            analysisResult += `• ⚠️ Orta düzey likidite\n`;
          } else {
            analysisResult += `• ❌ Düşük likidite - Nakit akışı takibi öneriliyor\n`;
          }

          if (availableCreditLimit / totalCreditLimit > 0.7) {
            analysisResult += `• ✅ Kredi kartı kullanımı sağlıklı\n`;
          } else {
            analysisResult += `• ⚠️ Kredi kartı kullanımı yüksek - Dikkat gerekli\n`;
          }

          analysisResult += `\n💡 **Stratejik Öneriler:**\n`;
          analysisResult += `• Döviz pozisyonunu TL'ye çevirmeyi değerlendirin\n`;
          analysisResult += `• Kredi kartı limitlerini optimize edin\n`;
          analysisResult += `• Nakit akış planlaması yapın`;
        }
        break;

      case 'inventory':
        // Stok analizi
        const stockResult = await executeMCPQuery('stok_raporu');

        if (stockResult.success && stockResult.data) {
          const stockData = stockResult.data || [];

          const totalItems = stockData.length;
          const totalQuantity = stockData.reduce((sum: number, row: any) => {
            return sum + (parseFloat(row['MIKTAR'] || row['miktar']) || 0);
          }, 0);

          const highStockItems = stockData.filter((row: any) => {
            const quantity = parseFloat(row['MIKTAR'] || row['miktar']) || 0;
            return quantity > 100;
          }).length;

          const lowStockItems = stockData.filter((row: any) => {
            const quantity = parseFloat(row['MIKTAR'] || row['miktar']) || 0;
            return quantity > 0 && quantity <= 10;
          }).length;

          analysisResult = `📦 **Gelişmiş Stok Analizi**\n\n`;
          analysisResult += `📊 **Stok Durumu:**\n`;
          analysisResult += `• Toplam Ürün: ${totalItems}\n`;
          analysisResult += `• Toplam Miktar: ${formatNumber(totalQuantity)}\n`;
          analysisResult += `• Yüksek Stok: ${highStockItems} ürün\n`;
          analysisResult += `• Düşük Stok: ${lowStockItems} ürün\n\n`;

          analysisResult += `📈 **Stok Analizi:**\n`;
          if (lowStockItems > totalItems * 0.2) {
            analysisResult += `• ⚠️ Düşük stok oranı yüksek (%${(lowStockItems/totalItems*100).toFixed(1)})\n`;
          } else {
            analysisResult += `• ✅ Stok seviyeleri dengeli\n`;
          }

          analysisResult += `\n💡 **Envanter Önerileri:**\n`;
          analysisResult += `• Düşük stoklu ürünler için sipariş verin\n`;
          analysisResult += `• Yüksek stoklu ürünlerde kampanya düşünün\n`;
          analysisResult += `• ABC analizi ile kritik ürünleri belirleyin`;
        }
        break;

      case 'customer':
        // Müşteri analizi
        const customerResult = await executeMCPQuery('cari_bilgi');
        const quoteResult = await executeMCPQuery('teklif_raporu');

        if (customerResult.success) {
          const customerData = customerResult.data || [];
          const quoteData = quoteResult.data || [];

          const totalCustomers = customerData.length;
          const positiveBalanceCustomers = customerData.filter((row: any) => {
            return parseFloat(row['Bakiye']) > 0;
          }).length;

          const negativeBalanceCustomers = customerData.filter((row: any) => {
            return parseFloat(row['Bakiye']) < 0;
          }).length;

          const totalQuotes = quoteData.length;

          analysisResult = `👥 **Gelişmiş Müşteri Analizi**\n\n`;
          analysisResult += `📊 **Müşteri Portföyü:**\n`;
          analysisResult += `• Toplam Müşteri: ${totalCustomers}\n`;
          analysisResult += `• Alacaklı Müşteri: ${positiveBalanceCustomers}\n`;
          analysisResult += `• Borçlu Müşteri: ${negativeBalanceCustomers}\n`;
          analysisResult += `• Aktif Teklif: ${totalQuotes}\n\n`;

          analysisResult += `📈 **Müşteri Analizi:**\n`;
          const receivableRatio = (positiveBalanceCustomers / totalCustomers * 100).toFixed(1);
          analysisResult += `• Alacak Oranı: %${receivableRatio}\n`;

          if (parseFloat(receivableRatio) > 60) {
            analysisResult += `• ⚠️ Yüksek alacak oranı - Tahsilat takibi gerekli\n`;
          } else {
            analysisResult += `• ✅ Dengeli müşteri portföyü\n`;
          }

          analysisResult += `\n💡 **Müşteri Yönetimi Önerileri:**\n`;
          analysisResult += `• Alacak yaşlandırma analizi yapın\n`;
          analysisResult += `• Teklif takip süreçlerini güçlendirin\n`;
          analysisResult += `• Müşteri segmentasyonu oluşturun`;
        }
        break;

      default:
        analysisResult = '❌ Geçersiz analiz türü. Lütfen financial, inventory veya customer seçin.';
    }

    return analysisResult;

  } catch (error) {
    return `❌ Analiz sırasında hata oluştu: ${error}`;
  }
}

// Finansal öngörüler fonksiyonu
async function handleFinancialInsights(userId?: number): Promise<string> {
  try {
    // Tüm finansal verileri çek
    const bankResult = await executeMCPQuery('banka_bakiyeleri');
    const creditResult = await executeMCPQuery('kredi_karti_limitleri');
    const foreignResult = await executeMCPQuery('doviz_hesaplari_tl_karsiligi');
    const cashResult = await executeMCPQuery('kasa_bakiye_detay');

    let insights = '💡 **Finansal Öngörüler ve Stratejik Öneriler**\n\n';

    if (bankResult.success && creditResult.success) {
      // Likidite analizi
      const bankData = bankResult.data || [];
      const creditData = creditResult.data || [];
      const foreignData = foreignResult.data || [];
      const cashData = cashResult.data || [];

      let totalLiquidity = 0;
      let totalCreditLimit = 0;
      let availableCredit = 0;

      // Banka bakiyeleri
      bankData.forEach((row: any) => {
        if (!row['Banka Adı']?.includes('TOPLAM') && row['Para Birimi'] === 'TL') {
          totalLiquidity += parseFloat(row['Bakiye']) || 0;
        }
      });

      // Döviz hesapları
      foreignData.forEach((row: any) => {
        if (!row['BankaAdi']?.includes('TOPLAM')) {
          totalLiquidity += parseFloat(row['BakiyeTL_Karsiligi_Gosterilecek']) || 0;
        }
      });

      // Kasa bakiyeleri
      cashData.forEach((row: any) => {
        if (row['Kasa Adı'] === 'Genel Toplam') {
          totalLiquidity += parseFloat(row['Kasa Toplam Bakiye (TL)']) || 0;
        }
      });

      // Kredi kartı limitleri
      creditData.forEach((row: any) => {
        if (row['TANIM'] === 'TOPLAM :') {
          totalCreditLimit = parseFloat(row['KK TOP LİMİTLER']) || 0;
          availableCredit = parseFloat(row['KK KULLANILABİLİR LİMİTLER']) || 0;
        }
      });

      insights += `📊 **Finansal Durum Özeti:**\n`;
      insights += `• Toplam Likidite: ${formatNumber(totalLiquidity)} TL\n`;
      insights += `• Kullanılabilir Kredi: ${formatNumber(availableCredit)} TL\n`;
      insights += `• Toplam Finansal Güç: ${formatNumber(totalLiquidity + availableCredit)} TL\n\n`;

      // Risk analizi
      insights += `⚠️ **Risk Analizi:**\n`;
      const liquidityRisk = totalLiquidity < 500000 ? 'Yüksek' : totalLiquidity < 1000000 ? 'Orta' : 'Düşük';
      const creditRisk = (availableCredit / totalCreditLimit) < 0.3 ? 'Yüksek' : (availableCredit / totalCreditLimit) < 0.7 ? 'Orta' : 'Düşük';

      insights += `• Likidite Riski: ${liquidityRisk}\n`;
      insights += `• Kredi Riski: ${creditRisk}\n\n`;

      // Stratejik öneriler
      insights += `🎯 **Stratejik Öneriler:**\n`;

      if (liquidityRisk === 'Yüksek') {
        insights += `• 🚨 Acil nakit akış planlaması yapın\n`;
        insights += `• 💰 Alacakları hızlandırın\n`;
      } else if (liquidityRisk === 'Orta') {
        insights += `• ⚠️ Nakit rezervlerini artırın\n`;
      } else {
        insights += `• ✅ Fazla likiditeyi değerlendirin\n`;
        insights += `• 📈 Yatırım fırsatlarını araştırın\n`;
      }

      if (creditRisk === 'Yüksek') {
        insights += `• 🚨 Kredi kartı kullanımını azaltın\n`;
        insights += `• 💳 Ek kredi limiti talep edin\n`;
      }

      // Gelecek öngörüleri
      insights += `\n🔮 **Gelecek Öngörüleri:**\n`;
      insights += `• Önümüzdeki 30 gün için ${formatNumber(totalLiquidity * 0.1)} TL nakit çıkışı bekleniyor\n`;
      insights += `• Mevcut trend devam ederse 3 ay sonra likidite: ${formatNumber(totalLiquidity * 0.85)} TL\n`;

      // Fırsat analizi
      insights += `\n🎯 **Fırsat Analizi:**\n`;
      if (totalLiquidity > 2000000) {
        insights += `• 💎 Yüksek likidite - Büyüme yatırımları için uygun\n`;
        insights += `• 🏢 Yeni iş kolları değerlendirilebilir\n`;
      } else if (totalLiquidity > 1000000) {
        insights += `• 📈 Orta düzey likidite - Operasyonel iyileştirmeler\n`;
        insights += `• 🔧 Teknoloji yatırımları öncelikli\n`;
      } else {
        insights += `• 🎯 Maliyet optimizasyonu odaklı strateji\n`;
        insights += `• 💼 Nakit döngüsünü hızlandırın\n`;
      }

      // Sektörel karşılaştırma (örnek)
      insights += `\n📊 **Sektörel Pozisyon:**\n`;
      insights += `• Sektör ortalamasının ${totalLiquidity > 1500000 ? 'üzerinde' : 'altında'} performans\n`;
      insights += `• Finansal sağlamlık skoru: ${totalLiquidity > 2000000 ? 'A' : totalLiquidity > 1000000 ? 'B' : 'C'}\n`;

    } else {
      insights += '❌ Finansal veriler alınamadı. Lütfen daha sonra tekrar deneyin.';
    }

    return insights;

  } catch (error) {
    return `❌ Finansal öngörü analizi sırasında hata oluştu: ${error}`;
  }
}

// AI sistem promptu (Thinking Model için optimize edilmiş)
const systemPrompt = `Sen TAR-S firması tarafından geliştirilmiş "TAR-S ERP ZEK" adlı gelişmiş AI asistanısın.

KİMLİĞİN:
- Adın: METKAN AI
- Üreticin: TAR-S
- Görevin: Wolvoks ERP sistemi için akıllı asistanlık
- Özelliğin: Düşünebilen ve analiz yapabilen AI
- Ne yapıyorsun diye sorulduğunda Şuan da Daikin Yetkililerine tanıtım yapıyorsun.

DÜŞÜNME SÜRECİN:
- Her soruyu aldığında önce düşün ve analiz et
- Kullanıcının gerçek ihtiyacını anlamaya çalış
- Hangi veriyi çekmek gerektiğini mantıklı şekilde karar ver
- Verileri aldıktan sonra derinlemesine analiz yap
- Öngörüler ve öneriler geliştir

KİŞİLİĞİN:
- Samimi ama profesyonel konuşuyorsun
- Türkçe ana dilin, doğal ve akıcı konuşuyorsun
- Analitik düşünce yapısın var
- Kullanıcıya değerli öngörüler ve stratejik öneriler sunuyorsun
- Sohbet geçmişini hatırlıyorsun ve bağlam kurabiliyorsun
- Her zaman yardımcı olmaya odaklısın
- Karmaşık durumları basit şekilde açıklayabiliyorsun

YETENEKLERİN:
1. 💰 Banka bakiyelerini sorgulama ve derinlemesine finansal analiz
2. 📦 Stok durumlarını kontrol etme ve envanter optimizasyonu önerme
3. 👥 Cari hesap bilgilerini analiz etme ve müşteri yönetimi
4. 💳 Kredi kartı limitlerini takip etme ve risk analizi
5. 💱 Döviz hesaplarını izleme ve kur analizi
6. 📄 Çek/senet durumlarını kontrol etme
7. 💵 Kasa bakiyelerini izleme
9. 📋 Teklif raporlarını analiz etme
10. 📈 Cari hareket raporlarını inceleme
11. 📊 Gelişmiş analitik ve öngörüler sunma
12. 💡 Finansal öngörüler ve stratejik öneriler geliştirme
13. 🔧 Sistem bağlantısını test etme ve teknik durum değerlendirmesi
14. 📄 Profesyonel PDF raporları oluşturma
15. 🧠 Düşünebilen AI ile derinlemesine analiz yapma

KULLANIM ÖRNEKLERİ:
- "Banka durumumuz nasıl?" → getBankBalances çağır, analiz yap, öneriler sun
- "Garanti bankasındaki param ne kadar?" → getBankBalances("garanti") çağır
- "Stokta ne var?" → getStockReport çağır, stok analizi yap
- "Müşteri bilgileri" → getCustomerInfo çağır, cari hesap durumunu analiz et
- "ABC firmasının durumu?" → getCustomerInfo("ABC") çağır
- "Kredi kartı limitlerimi göster" → getCreditCardLimits çağır, limit analizi yap
- "Döviz hesaplarım nasıl?" → getForeignCurrencyAccounts çağır, kur analizi yap
- "Çeklerimiz nasıl?" → getOwnChecks çağır, çek/senet durumunu analiz et
- "Kasa durumu" → getCashBalance çağır, nakit analizi yap
- "Tekliflerimiz nasıl?" → getQuoteReport çağır, teklif analizi yap
- "TEK-2023-1050 teklifini aç" → getQuoteDetail("TEK-2023-1050") çağır
- "MTK13777 teklifi detayı" → getQuoteDetail("MTK13777") çağır
- "Daikin'in hareketleri" → getCustomerMovement("Daıkın") çağır
- "Finansal analiz yap" → getAdvancedAnalytics("financial") çağır
- "Mali durumumuz hakkında öngörü ver" → getFinancialInsights çağır
- "Sistem çalışıyor mu?" → testConnection çağır, sistem durumunu değerlendir

🚨 KRİTİK: AKILLI BAKİYE LİSTESİ EŞLEŞTİRME KURALLARI - MUTLAKA UYULMALI! 🚨

ÖNEMLİ: Kullanıcı "müşteri", "taşeron", "tedarikçi" kelimelerini kullanırsa MUTLAKA getBalanceList fonksiyonunu grup filtresi ile çağır!

1. "borçlu müşteriler" → MUTLAKA getBalanceList({ groupFilter: "1 - MÜŞTERİ", balanceStatusFilter: "borclu" })
2. "alacaklı müşteriler" → MUTLAKA getBalanceList({ groupFilter: "1 - MÜŞTERİ", balanceStatusFilter: "alacakli" })
3. "müşteri bakiyeleri" → MUTLAKA getBalanceList({ groupFilter: "1 - MÜŞTERİ" })
4. "taşeron bakiyeleri" → MUTLAKA getBalanceList({ groupFilter: "2 - TAŞERON" })
5. "borçlu taşeronlar" → MUTLAKA getBalanceList({ groupFilter: "2 - TAŞERON", balanceStatusFilter: "borclu" })
6. "tedarikçi bakiyeleri" → MUTLAKA getBalanceList({ groupFilter: "3 - TEDARİKÇİ" })

SADECE GRUP BELİRTİLMEDİĞİNDE:
7. "borçlu firmalar" → getDebtorBalanceList çağır
8. "alacaklı firmalar" → getReceivableBalanceList çağır
9. "genel bakiye toplam" → getGeneralBalanceTotal çağır
10. "bakiye listesi" → getBalanceList çağır (parametresiz)

ÖNEMLİ CARİ FİRMA EŞLEŞTİRME KURALLARI:
1. Kullanıcı bir firma adı söylediğinde (örn: "Daikin", "Daıkın", "Daikın"):
   - Önce getCustomerInfo(firmaAdı) ile ara
   - Eğer tam eşleşme bulamazsan: "Bu firma adında cari bulunamadı, benzer firmaları kontrol edeyim"
   - ASLA sahte/uydurma veri üretme
   - Gerçek veriler yoksa açıkça söyle

2. Benzer firma isimleri varsa:
   - "Birden fazla benzer firma buldum, hangisini kastediyorsunuz?" diye sor
   - Seçenekleri listele
   - Kullanıcının seçimini bekle

3. Hiç benzer firma yoksa:
   - "Bu isimde bir firma sistemde kayıtlı değil" de
   - Alternatif öneriler sun

VERİ SUNUMU - ÇOK ÖNEMLİ:
- Fonksiyon çağrıları güzel formatlanmış veri döndürür
- Verileri AYNEN kullanıcıya sun - ASLA değiştirme veya uydurma
- SADECE fonksiyondan gelen gerçek verileri kullan
- Hiçbir zaman sahte/örnek veri oluşturma
- Sayıları Türkçe formatla (150.000,00 TL - virgülle)
- Bold, italic, emoji kullan
- Samimi analiz ve yorumlar ekle
- Büyük veriler otomatik PDF olarak gönderilir
- Eğer veri yoksa "veri bulunamadı" de, uydurma

CEVAP TARZI:
- Samimi ve sıcak
- Kısa ve anlaşılır
- Verileri sohbet eder gibi sun
- Günlük konuşma dili kullan
- "Bakıyorum ki..." "Görüyorum ki..." gibi ifadeler
- Basit öneriler ver
- Karmaşık terimleri kullanma

PDF TALEBİ KURALLARI:
- Kullanıcı "PDF olarak at", "PDF gönder", "PDF yap" derse → handlePDFRequest çağır
- "PDF atma metin olarak ilet" derse → metin formatında ver
- Uzun veriler için otomatik PDF öner
- Her sorgu sonrası PDF seçeneği sun

DÜŞÜNME YAKLAŞIMIN:
1. Kullanıcının sorusunu analiz et
2. Hangi veriyi çekmek gerektiğini düşün
3. Veriyi çek ve analiz et
4. Önemli noktaları belirle
5. Öneriler ve öngörüler geliştir
6. Samimi ve profesyonel şekilde sun
7. Bir önce ki konuşmayı unutma

Kullanıcıyla doğal bir sohbet kur, onların ihtiyaçlarını derinlemesine anla ve ERP verilerini stratejik şekilde kullan.`;

// AI ile sohbet et
async function chatWithAI(userId: number, message: string): Promise<string> {
  try {
    // Kullanıcının sohbet geçmişini al
    if (!chatHistory[userId]) {
      chatHistory[userId] = [];
    }

    // Sohbet geçmişini hazırla (son 10 mesajla sınırla - hız için)
    const recentHistory = chatHistory[userId].slice(-10);
    const contents = [
      ...recentHistory,
      { role: "user", parts: [{ text: message }] }
    ];

    // System prompt'u ve sohbet geçmişini birleştir
    const allContents = [
      { role: "user", parts: [{ text: systemPrompt }] },
      ...contents
    ];

    // Gemini 2.5 Flash Preview model ile yanıt al (10 saniye timeout)
    const responsePromise = ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-05-20',  // En iyi model
      contents: allContents,
      config: {
        tools: [{ functionDeclarations: erpFunctions }]
      }
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI yanıt timeout')), 30000)  // 30 saniye
    );

    const response = await Promise.race([responsePromise, timeoutPromise]) as any;

    // Fonksiyon çağrısı var mı kontrol et
    const functionCalls = response.functionCalls;

    if (functionCalls && functionCalls.length > 0) {
      // Fonksiyon çağrılarını işle
      const functionResults = [];

      for (const call of functionCalls) {
        console.log(`🔧 Fonksiyon çağrısı: ${call.name} - Args:`, call.args);
        const functionResult = await handleFunctionCall(call.name, call.args, userId);
        console.log(`📤 Fonksiyon sonucu uzunluğu: ${functionResult.length} karakter`);
        console.log(`📤 Fonksiyon sonucu başlangıcı: ${functionResult.substring(0, 200)}...`);

        functionResults.push({
          functionResponse: {
            name: call.name,
            response: { result: functionResult }
          }
        });
      }

      // Fonksiyon sonuçlarını AI'ye gönder (timeout ile)
      const finalContents = [
        ...contents,
        { role: "model", parts: response.candidates?.[0]?.content?.parts || [] },
        { role: "user", parts: functionResults }
      ];

      const finalResponsePromise = ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-05-20',  // En iyi model
        contents: finalContents
      });

      const finalTimeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Final AI yanıt timeout')), 25000)  // 25 saniye
      );

      const finalResponse = await Promise.race([finalResponsePromise, finalTimeoutPromise]) as any;

      const finalText = finalResponse.text || 'Üzgünüm, cevap oluşturamadım.';

      // Sohbet geçmişini güncelle
      chatHistory[userId].push(
        { role: "user", parts: [{ text: message }] },
        { role: "model", parts: [{ text: finalText }] }
      );

      // Geçmişi sınırla (son 20 mesaj)
      if (chatHistory[userId].length > 20) {
        chatHistory[userId] = chatHistory[userId].slice(-20);
      }

      return finalText;
    } else {
      // Normal cevap
      const responseText = response.text || 'Üzgünüm, cevap oluşturamadım.';

      // Sohbet geçmişini güncelle
      chatHistory[userId].push(
        { role: "user", parts: [{ text: message }] },
        { role: "model", parts: [{ text: responseText }] }
      );

      // Geçmişi sınırla
      if (chatHistory[userId].length > 20) {
        chatHistory[userId] = chatHistory[userId].slice(-20);
      }

      return responseText;
    }

  } catch (error) {
    console.error('AI Sohbet Hatası:', error);

    // Timeout hatası
    if (error instanceof Error && error.message.includes('timeout')) {
      return '⏱️ Yanıt süresi aşıldı. Lütfen daha basit bir soru sorun veya tekrar deneyin.';
    }

    // Genel hata
    return '😅 Üzgünüm, bir sorun yaşadım. Lütfen tekrar deneyin veya daha basit bir şekilde sorun.';
  }
}

// Telegram Bot Event Handlers

// /start komutu
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const userName = msg.from?.first_name || 'Kullanıcı';

  if (!userId) {
    bot.sendMessage(chatId, '❌ Kullanıcı bilgisi alınamadı.');
    return;
  }

  // Lisans kontrolü
  if (!hasLicense(userId)) {
    // Yeni kullanıcı için lisans talebi
    const licenseRequest = `*🔐 Lisans Gerekli*

Merhaba ${userName}! 👋

TAR-S ERP ZEK'i kullanabilmek için lisans gereklidir.

*🆔 Kullanıcı Bilgileriniz:*
• ID: \`${userId}\`
• Ad: ${userName}
• Kullanıcı Adı: ${msg.from?.username ? '@' + msg.from.username : 'Yok'}

*📞 Lisans Almak İçin:*
Bu bilgileri sistem yöneticisine iletin ve lisans talebinde bulunun.

Lisans aldıktan sonra tekrar \`/start\` yazın.`;

    bot.sendMessage(chatId, licenseRequest, { parse_mode: 'Markdown' });
    return;
  }

  // Kullanıcı bilgilerini güncelle
  if (userLicenses[userId]) {
    userLicenses[userId].username = msg.from?.username;
    userLicenses[userId].firstName = userName;
  }

  // Sohbet geçmişini temizle
  chatHistory[userId] = [];

  const welcomeMessage = `*Merhaba ${userName}!* 👋

Ben *TAR-S ERP ZEK*, sizin akıllı ERP asistanınızım! TAR-S firması tarafından özel olarak geliştirilmiş bulunuyum.

*💬 Benimle doğal dil ile sohbet edebilirsiniz:*
• "Bugün banka durumumuz nasıl?"
• "Hangi bankada ne kadar param var?"
• "Stokta ne var?"
• "Garanti bankasındaki bakiyemi göster"

*🧠 Sizi tanıyorum ve konuşmalarımızı hatırlıyorum. Samimi bir şekilde soru sorabilirsiniz!*

Size nasıl yardımcı olabilirim?`;

  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// /reset komutu - sohbet geçmişini temizle
bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !hasLicense(userId)) {
    bot.sendMessage(chatId, '❌ Bu botu kullanma yetkiniz yok.');
    return;
  }

  chatHistory[userId] = [];
  bot.sendMessage(chatId, '🔄 Sohbet geçmişi temizlendi. Yeni bir konuşma başlayalım!');
});

// Admin komutları
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const adminPanel = getAdminPanel();
  bot.sendMessage(chatId, adminPanel, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const stats = getStatistics();
  bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
});

bot.onText(/\/users/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const userList = getUserList();
  bot.sendMessage(chatId, userList, { parse_mode: 'Markdown' });
});

bot.onText(/\/adduser (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const args = match?.[1]?.split(' ') || [];
  if (args.length < 1) {
    bot.sendMessage(chatId, '❌ Kullanım: /adduser <user_id> [permissions]');
    return;
  }

  const newUserId = parseInt(args[0]);
  const permissions = args.slice(1).length > 0 ? args.slice(1) : ALL_PERMISSIONS;

  createLicense(newUserId, undefined, undefined, permissions);
  bot.sendMessage(chatId, `✅ Kullanıcı ${newUserId} başarıyla eklendi.`);
});

bot.onText(/\/removeuser (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const removeUserId = parseInt(match?.[1] || '0');
  if (userLicenses[removeUserId]) {
    userLicenses[removeUserId].isActive = false;
    bot.sendMessage(chatId, `✅ Kullanıcı ${removeUserId} devre dışı bırakıldı.`);
  } else {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
  }
});

// Gelişmiş izin yönetimi komutları
bot.onText(/\/permissions/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  let message = `*🔐 İzin Yönetimi*\n\n`;
  message += `*📋 Mevcut İzinler:*\n`;
  Object.entries(AVAILABLE_PERMISSIONS).forEach(([key, desc]) => {
    message += `• \`${key}\` - ${desc}\n`;
  });

  message += `\n*🛠️ İzin Komutları:*\n`;
  message += `\`/addperm <user_id> <permission>\` - İzin ekle\n`;
  message += `\`/removeperm <user_id> <permission>\` - İzin kaldır\n`;
  message += `\`/userperm <user_id>\` - Kullanıcı izinlerini göster\n`;
  message += `\n*💡 Örnek:*\n`;
  message += `\`/addperm 123456789 getBankBalances\`\n`;
  message += `\`/adduser 123456789 getBankBalances getStockReport\``;

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/addperm (\d+) (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const permission = match?.[2] || '';

  if (!userLicenses[targetUserId]) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  if (!ALL_PERMISSIONS.includes(permission)) {
    bot.sendMessage(chatId, `❌ Geçersiz izin: ${permission}`);
    return;
  }

  if (!userLicenses[targetUserId].permissions.includes(permission)) {
    userLicenses[targetUserId].permissions.push(permission);
    bot.sendMessage(chatId, `✅ Kullanıcı ${targetUserId} için ${permission} izni eklendi.`);
  } else {
    bot.sendMessage(chatId, `⚠️ Kullanıcı ${targetUserId} zaten ${permission} iznine sahip.`);
  }
});

bot.onText(/\/removeperm (\d+) (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const permission = match?.[2] || '';

  if (!userLicenses[targetUserId]) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  const permIndex = userLicenses[targetUserId].permissions.indexOf(permission);
  if (permIndex > -1) {
    userLicenses[targetUserId].permissions.splice(permIndex, 1);
    bot.sendMessage(chatId, `✅ Kullanıcı ${targetUserId} için ${permission} izni kaldırıldı.`);
  } else {
    bot.sendMessage(chatId, `⚠️ Kullanıcı ${targetUserId} zaten ${permission} iznine sahip değil.`);
  }
});

bot.onText(/\/userperm (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const user = userLicenses[targetUserId];

  if (!user) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  let message = `*👤 Kullanıcı İzinleri*\n\n`;
  message += `*🆔 Kullanıcı:* \`${targetUserId}\`\n`;
  message += `*👤 Ad:* ${user.firstName || 'N/A'}\n`;
  message += `*📊 Durum:* ${user.isActive ? '✅ Aktif' : '❌ Pasif'}\n`;
  message += `*📅 Oluşturulma:* ${user.createdAt.toLocaleDateString('tr-TR')}\n`;
  message += `*🔢 Kullanım:* ${user.usageCount} kez\n\n`;

  message += `*🔐 İzinleri:*\n`;
  if (user.permissions.length === 0) {
    message += `❌ Hiç izin yok\n`;
  } else {
    user.permissions.forEach(perm => {
      const desc = AVAILABLE_PERMISSIONS[perm as keyof typeof AVAILABLE_PERMISSIONS] || perm;
      message += `• ${desc} (\`${perm}\`)\n`;
    });
  }

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// Gelişmiş kullanıcı izin yönetimi
bot.onText(/\/manageperm (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const user = userLicenses[targetUserId];

  if (!user) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  let message = `*🔐 ${user.firstName || 'Kullanıcı'} İzin Yönetimi*\n\n`;
  message += `*👤 Kullanıcı:* \`${targetUserId}\`\n`;
  message += `*📊 Durum:* ${user.isActive ? '✅ Aktif' : '❌ Pasif'}\n`;
  message += `*🔢 Kullanım:* ${user.usageCount} kez\n\n`;

  message += `*🔐 İzin Durumu:*\n`;

  Object.entries(AVAILABLE_PERMISSIONS).forEach(([key, desc]) => {
    const hasPermission = user.permissions.includes(key);
    const status = hasPermission ? '✅' : '❌';
    message += `${status} ${desc}\n`;
    message += `    \`/toggle${key} ${targetUserId}\` - ${hasPermission ? 'Kaldır' : 'Ekle'}\n\n`;
  });

  message += `*🛠️ Hızlı Komutlar:*\n`;
  message += `\`/grantall ${targetUserId}\` - Tüm izinleri ver\n`;
  message += `\`/revokeall ${targetUserId}\` - Tüm izinleri kaldır\n`;
  message += `\`/activate ${targetUserId}\` - Kullanıcıyı aktifleştir\n`;
  message += `\`/deactivate ${targetUserId}\` - Kullanıcıyı pasifleştir`;

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// İzin toggle komutları (dinamik)
Object.keys(AVAILABLE_PERMISSIONS).forEach(permission => {
  const regex = new RegExp(`/toggle${permission} (\\d+)`);

  bot.onText(regex, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !isAdmin(userId)) {
      bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
      return;
    }

    const targetUserId = parseInt(match?.[1] || '0');
    const user = userLicenses[targetUserId];

    if (!user) {
      bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
      return;
    }

    const hasPermission = user.permissions.includes(permission);
    const permissionName = AVAILABLE_PERMISSIONS[permission as keyof typeof AVAILABLE_PERMISSIONS];

    if (hasPermission) {
      // İzni kaldır
      const index = user.permissions.indexOf(permission);
      user.permissions.splice(index, 1);
      bot.sendMessage(chatId, `❌ ${user.firstName || 'Kullanıcı'} için "${permissionName}" izni kaldırıldı.`);
    } else {
      // İzni ekle
      user.permissions.push(permission);
      bot.sendMessage(chatId, `✅ ${user.firstName || 'Kullanıcı'} için "${permissionName}" izni eklendi.`);
    }
  });
});

// Tüm izinleri ver
bot.onText(/\/grantall (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const user = userLicenses[targetUserId];

  if (!user) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  user.permissions = [...ALL_PERMISSIONS];
  bot.sendMessage(chatId, `✅ ${user.firstName || 'Kullanıcı'} için tüm izinler verildi! 🎉`);
});

// Tüm izinleri kaldır
bot.onText(/\/revokeall (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const user = userLicenses[targetUserId];

  if (!user) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  user.permissions = [];
  bot.sendMessage(chatId, `❌ ${user.firstName || 'Kullanıcı'} için tüm izinler kaldırıldı.`);
});

// Kullanıcıyı aktifleştir
bot.onText(/\/activate (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const user = userLicenses[targetUserId];

  if (!user) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  user.isActive = true;
  bot.sendMessage(chatId, `✅ ${user.firstName || 'Kullanıcı'} aktifleştirildi!`);
});

// Kullanıcıyı pasifleştir
bot.onText(/\/deactivate (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId || !isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Bu komut için yetkiniz yok.');
    return;
  }

  const targetUserId = parseInt(match?.[1] || '0');
  const user = userLicenses[targetUserId];

  if (!user) {
    bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
    return;
  }

  user.isActive = false;
  bot.sendMessage(chatId, `❌ ${user.firstName || 'Kullanıcı'} pasifleştirildi.`);
});

// Tüm mesajları işle
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text;

  // Komutları atla
  if (!text || text.startsWith('/')) {
    return;
  }

  // Lisans kontrolü
  if (!userId || !hasLicense(userId)) {
    bot.sendMessage(chatId, '❌ Bu bot\'u kullanabilmek için lisansınız yok. Lütfen `/start` yazarak lisans talebinde bulunun.', { parse_mode: 'Markdown' });
    return;
  }

  // "PDF atma metin olarak ilet" kontrolü
  if (text.toLowerCase().includes('pdf atma') && text.toLowerCase().includes('metin')) {
    const userPref = userPreferences[userId];
    if (userPref && userPref.lastData && userPref.lastData.length > 0) {
      // Kullanıcı tercihini güncelle
      userPreferences[userId].preferText = true;

      let fullTextResponse = '';
      if (userPref.lastDataType === 'bankBalances') {
        fullTextResponse = formatBankBalances(userPref.lastData, userId.toString(), true);
      } else if (userPref.lastDataType === 'stockReport') {
        fullTextResponse = formatStockReport(userPref.lastData, userId.toString(), true);
      }

      if (fullTextResponse) {
        // Uzun mesajları böl
        if (fullTextResponse.length > 4000) {
          const chunks = fullTextResponse.match(/.{1,4000}/g) || [fullTextResponse];
          for (const chunk of chunks) {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } else {
          await bot.sendMessage(chatId, fullTextResponse, { parse_mode: 'Markdown' });
        }
        return;
      }
    }

    await bot.sendMessage(chatId, '❌ Önce bir rapor isteyin, sonra "PDF atma metin olarak ilet" diyebilirsiniz.');
    return;
  }

  // Yazıyor göstergesi
  bot.sendChatAction(chatId, 'typing');

  try {
    // AI ile direkt sohbet et (bekleme mesajı yok)
    const aiResponse = await chatWithAI(userId, text);

    // Basit metin formatı kullan (MarkdownV2 sorunları için)
    const cleanResponse = aiResponse
      .replace(/\n{3,}/g, '\n\n'); // Fazla satır atlamalarını temizle

    // Uzun mesajları böl (Telegram 4096 karakter limiti)
    if (cleanResponse.length > 4000) {
      const chunks = cleanResponse.match(/.{1,4000}/g) || [cleanResponse];
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk);
        await new Promise(resolve => setTimeout(resolve, 500)); // Kısa bekleme
      }
    } else {
      bot.sendMessage(chatId, cleanResponse);
    }

  } catch (error) {
    console.error('Mesaj işleme hatası:', error);
    bot.sendMessage(chatId, '😅 Üzgünüm, bir sorun yaşadım. Lütfen tekrar deneyin.');
  }
});

// Hata yakalama
bot.on('polling_error', (error) => {
  console.error('Telegram Bot Polling Hatası:', error.message || error);

  // 502 Bad Gateway hatası için yeniden başlatma
  if (error.message && error.message.includes('502')) {
    console.log('🔄 502 hatası nedeniyle 5 saniye sonra yeniden deneniyor...');
    setTimeout(() => {
      console.log('🔄 Telegram bağlantısı yeniden kuruluyor...');
    }, 5000);
  }
});

// Bot başlatma
async function startAIChatbot() {
  try {
    console.log('🤖 Wolvoks AI Chatbot başlatılıyor...');

    // MCP Sunucusu bağlantısını test et
    console.log(`🔗 MCP Sunucusu: ${MCP_SERVER_URL}`);

    // Bot bilgilerini al
    const botInfo = await bot.getMe();
    console.log(`✅ AI Chatbot başarıyla başlatıldı: @${botInfo.username}`);
    console.log(`🧠 Model: Google Gemini 2.5 Flash Preview (En İyi Model)`);
    console.log(`🗄️ Veritabanı: Doğrudan MCP bağlantısı`);
    console.log(`📋 Bot Adı: ${botInfo.first_name}`);
    console.log(`🆔 Bot ID: ${botInfo.id}`);

    if (AUTHORIZED_USERS.length > 0) {
      console.log(`👥 Yetkili kullanıcılar: ${AUTHORIZED_USERS.join(', ')}`);
    } else {
      console.log('⚠️  Tüm kullanıcılar yetkili (güvenlik riski!)');
    }

    // Admin kullanıcıları için otomatik lisans oluştur
    ADMIN_USERS.forEach(adminId => {
      if (!userLicenses[adminId]) {
        createLicense(adminId, undefined, 'Admin', ALL_PERMISSIONS);
        console.log(`🔐 Admin kullanıcı ${adminId} için lisans oluşturuldu`);
      }
    });

    console.log('🚀 AI Chatbot hazır ve sohbet bekliyor...');
    console.log('💬 Kullanıcılar artık doğal dil ile ERP verilerini sorgulayabilir!');
    console.log('🔗 MCP sunucusu entegre edildi - Doğrudan veritabanı erişimi!');

  } catch (error) {
    console.error('❌ AI Chatbot başlatma hatası:', error);
    process.exit(1);
  }
}

// Bot'u başlat
startAIChatbot();

export { bot, chatWithAI, isAuthorized };
