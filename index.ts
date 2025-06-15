import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import sql from 'mssql';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';

// .env dosyasını yükle
dotenv.config();

// Çevre değişkenlerini kontrol et
const requiredEnvVars = ['MSSQL_SERVER', 'MSSQL_DATABASE', 'MSSQL_USERNAME', 'MSSQL_PASSWORD'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Gerekli çevre değişkeni eksik: ${envVar}`);
  }
}

// API Key'leri ve yetkileri yönetmek için basit bir sistem
interface UserPermissions {
  apiKey: string;
  name: string;
  allowedQueries: string[];
  rateLimit: number; // dakika başına sorgu limiti
  lastRequestTime?: number;
  requestCount?: number;
}

// Örnek kullanıcılar ve yetkiler
const users: UserPermissions[] = [
  {
    apiKey: "wolvoks_admin_key_12345",
    name: "Admin User",
    allowedQueries: ["*"], // Tüm sorguları çalıştırabilir
    rateLimit: 100
  },
  {
    apiKey: "wolvoks_readonly_key_67890",
    name: "Read Only User", 
    allowedQueries: ["banka_bakiyeleri", "stok_raporu"], // Sadece belirli sorguları çalıştırabilir
    rateLimit: 30
  }
];

// SQL bağlantı havuzu
let pool: sql.ConnectionPool | null = null;

// Veritabanı bağlantısını başlat
async function initializeDatabase(): Promise<void> {
  try {
    const config: sql.config = {
      server: process.env.MSSQL_SERVER!,
      database: process.env.MSSQL_DATABASE!,
      user: process.env.MSSQL_USERNAME!,
      password: process.env.MSSQL_PASSWORD!,
      options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        requestTimeout: 120000, // 2 dakika timeout
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    pool = await new sql.ConnectionPool(config).connect();
    console.error('MSSQL veritabanına başarıyla bağlandı');
  } catch (error) {
    console.error('Veritabanı bağlantı hatası:', error);
    throw error;
  }
}

// API Key doğrulama
function validateApiKey(apiKey: string): UserPermissions | null {
  return users.find(user => user.apiKey === apiKey) || null;
}

// Rate limiting kontrolü
function checkRateLimit(user: UserPermissions): boolean {
  const now = Date.now();
  const oneMinute = 60 * 1000;

  if (!user.lastRequestTime || (now - user.lastRequestTime) > oneMinute) {
    user.lastRequestTime = now;
    user.requestCount = 1;
    return true;
  }

  if (user.requestCount! < user.rateLimit) {
    user.requestCount!++;
    return true;
  }

  return false;
}

// SQL sorguları tanımları
const predefinedQueries = {
  banka_bakiyeleri: {
    name: "Banka Bakiyeleri",
    description: "Banka hesaplarının bakiye durumlarını getirir",
    parameters: [
      {
        name: "banka_adi",
        type: "string",
        description: "Filtrelemek için banka adı (opsiyonel)",
        required: false
      },
      {
        name: "para_birimi",
        type: "string",
        description: "Filtrelemek için para birimi (TL, USD, EUR vb.) (opsiyonel)",
        required: false
      }
    ],
    query: `
      DECLARE @ArananBankaAdiParam NVARCHAR(100) = NULL;
      DECLARE @ArananParaBirimi NVARCHAR(10) = NULL;

      WITH BankaHesapBakiyeleriDetay AS (
          SELECT
              BA.BANKA_ADI AS BankaAdiOriginal,
              BHES.HESAP_NO AS HesapNo,
              BHES.TANIMI AS HesapTanimi,
              BHES.HESAP_TURU AS ParaBirimi,
              dbo.SAYIYUVARLA1(
                  ISNULL(SUM(ISNULL(BHR.TUTAR_ALACAK, 0) - ISNULL(BHR.TUTAR_BORC, 0)), 0)
              , 2, 0) AS BakiyeMatematiksel,
              1 AS SiraTipi,
              BA.BANKA_ADI AS OrderBankaAdi
          FROM
              BANKA_HESAP BHES
          INNER JOIN
              BANKA_ADI BA ON BHES.BLBNKODU = BA.BLKODU
          LEFT JOIN
              BANKAHR BHR ON BHES.BLKODU = BHR.BLHSKODU AND BHR.SILINDI = 0
          WHERE
              BHES.CEK_KREDI_HESABI = '0'
              AND BHES.VADELI = 0
              AND BHES.KAPANIS_TARIHI IS NULL
              AND BHES.HESAP_TURU IS NOT NULL AND BHES.HESAP_TURU <> ''
              AND (@ArananBankaAdiParam IS NULL OR BA.BANKA_ADI LIKE '%' + @ArananBankaAdiParam + '%')
              AND (@ArananParaBirimi IS NULL OR BHES.HESAP_TURU = @ArananParaBirimi)
          GROUP BY
              BA.BANKA_ADI,
              BHES.HESAP_NO,
              BHES.TANIMI,
              BHES.HESAP_TURU
          HAVING
              dbo.SAYIYUVARLA1(ISNULL(SUM(ISNULL(BHR.TUTAR_ALACAK, 0) - ISNULL(BHR.TUTAR_BORC, 0)), 0), 2, 0) <> 0
      ),
      ToplamlarParabirimiBazinda AS (
          SELECT
              ParaBirimi,
              SUM(BakiyeMatematiksel) AS ToplamBakiyeMatematiksel
          FROM BankaHesapBakiyeleriDetay
          GROUP BY ParaBirimi
      ),
      BirlesikRapor AS (
          SELECT
              BankaAdiOriginal AS BankaAdiGosterilecek,
              HesapNo,
              HesapTanimi,
              ParaBirimi,
              BakiyeMatematiksel,
              CASE
                  WHEN BakiyeMatematiksel < 0 THEN ABS(BakiyeMatematiksel)
                  ELSE BakiyeMatematiksel
              END AS GosterilecekTutar,
              CASE
                  WHEN BakiyeMatematiksel < 0 THEN 'Mevcut Bakiye'
                  WHEN BakiyeMatematiksel > 0 THEN 'Borç Bakiyesi'
                  ELSE 'Sıfır Bakiye'
              END AS DurumAciklamasi,
              SiraTipi,
              OrderBankaAdi
          FROM BankaHesapBakiyeleriDetay
          UNION ALL
          SELECT
              TPB.ParaBirimi + ' TOPLAM:' AS BankaAdiGosterilecek,
              NULL AS HesapNo,
              NULL AS HesapTanimi,
              TPB.ParaBirimi AS ParaBirimi,
              TPB.ToplamBakiyeMatematiksel AS BakiyeMatematiksel,
              CASE
                  WHEN TPB.ToplamBakiyeMatematiksel < 0 THEN ABS(TPB.ToplamBakiyeMatematiksel)
                  ELSE TPB.ToplamBakiyeMatematiksel
              END AS GosterilecekTutar,
              CASE
                  WHEN TPB.ToplamBakiyeMatematiksel < 0 THEN 'Toplam Mevcut Bakiye'
                  WHEN TPB.ToplamBakiyeMatematiksel > 0 THEN 'Toplam Borç Bakiyesi'
                  ELSE 'Toplam Sıfır Bakiye'
              END AS DurumAciklamasi,
              2 AS SiraTipi,
              TPB.ParaBirimi AS OrderBankaAdi
          FROM ToplamlarParabirimiBazinda TPB
      )
      SELECT
          BankaAdiGosterilecek AS "Banka Adı",
          HesapNo AS "Hesap No",
          HesapTanimi AS "Hesap Tanımı",
          ParaBirimi AS "Para Birimi",
          GosterilecekTutar AS "Bakiye",
          DurumAciklamasi AS "Durum"
      FROM BirlesikRapor
      ORDER BY
          SiraTipi,
          ParaBirimi,
          OrderBankaAdi,
          CASE WHEN HesapNo IS NULL THEN 1 ELSE 0 END,
          BankaAdiGosterilecek,
          HesapNo;
    `
  },
  // Buraya daha fazla sorgu ekleyebilirsiniz
  stok_raporu: {
    name: "Stok Raporu",
    description: "Stok durumlarını ve miktarlarını getirir",
    parameters: [
      {
        name: "urun_adi",
        type: "string",
        description: "Aranacak ürün adı (opsiyonel)",
        required: false
      },
      {
        name: "depo_adi",
        type: "string",
        description: "Filtrelemek için depo adı (opsiyonel)",
        required: false
      }
    ],
    query: `
DECLARE @ArananUrunAdi NVARCHAR(255) = NULL;
DECLARE @ArananDepoAdi NVARCHAR(50) = NULL;

-- Hedef depoların tanımlanması
DECLARE @HedefDepolar TABLE (DepoAdiKolonu NVARCHAR(50) PRIMARY KEY);
INSERT INTO @HedefDepolar (DepoAdiKolonu) VALUES
('1. BAYTUR'),
('1. MERKEZ'),
('1. TRANSFER'),
('2. ARIZALI'),
('2. EL CIHAZ');

-- Ana stok miktarı sorgusu
SELECT
    S.STOKKODU AS 'STOK_KODU',
    S.STOK_ADI AS 'STOK_ADI',
    IDP.DepoAdiKolonu AS 'DEPO_ADI',
    (
        COALESCE(SUM(CASE WHEN SH.TUTAR_TURU = 1 THEN SH.KPB_GMIK ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN SH.TUTAR_TURU = 0 THEN SH.KPB_CMIK ELSE 0 END), 0)
    ) AS 'MIKTAR'
FROM
    STOK S
INNER JOIN
    STOKHR SH ON S.BLKODU = SH.BLSTKODU
INNER JOIN
    @HedefDepolar IDP ON SH.DEPO_ADI = IDP.DepoAdiKolonu
WHERE
    (@ArananUrunAdi IS NULL OR S.STOK_ADI LIKE '%' + @ArananUrunAdi + '%')
    AND (@ArananDepoAdi IS NULL OR IDP.DepoAdiKolonu LIKE '%' + @ArananDepoAdi + '%')
    AND (S.AKTIF = 1 OR S.AKTIF IS NULL)
    AND S.ANA_STOK = 0
    AND SH.SILINDI = 0
GROUP BY
    S.STOKKODU,
    S.STOK_ADI,
    IDP.DepoAdiKolonu
HAVING
    (
        COALESCE(SUM(CASE WHEN SH.TUTAR_TURU = 1 THEN SH.KPB_GMIK ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN SH.TUTAR_TURU = 0 THEN SH.KPB_CMIK ELSE 0 END), 0)
    ) > 0
ORDER BY
    S.STOK_ADI,
    IDP.DepoAdiKolonu;
    `
  },
  test_baglanti: {
    name: "Test Bağlantı",
    description: "Veritabanı bağlantısını ve tablo yapısını test eder",
    parameters: [],
    query: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
  },
  basit_banka_test: {
    name: "Basit Banka Test",
    description: "Banka tablolarını basit şekilde test eder",
    parameters: [],
    query: "SELECT TOP 5 * FROM BANKA_ADI"
  },
  banka_tablolari: {
    name: "Banka Tabloları",
    description: "BANKA ile başlayan tüm tabloları listeler",
    parameters: [],
    query: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE 'BANKA%' ORDER BY TABLE_NAME"
  },

  cari_bilgi: {
    name: "Cari Bilgi",
    description: "Cari hesap bilgilerini ve bakiyelerini listeler",
    parameters: [
      {
        name: "cari_unvani",
        type: "string",
        description: "Aranacak cari ünvanı (opsiyonel)",
        required: false
      },
      {
        name: "para_birimi",
        type: "string",
        description: "Filtrelemek için para birimi (TL, EUR, USD vb.) (opsiyonel)",
        required: false
      }
    ],
    query: `
DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;
DECLARE @ArananParaBirimi NVARCHAR(10) = NULL;

SELECT
    C.TICARI_UNVANI AS CariUnvan,
    CASE
        WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN CH.DOVIZ_BIRIMI2
        ELSE 'TL'
    END AS ParaBirimi,
    SUM(
        ISNULL(
            CASE
                WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN CH.DVZ_BTUT2
                ELSE CH.KPB_BTUT
            END,
        0)
    ) AS ToplamBorc,
    SUM(
        ISNULL(
            CASE
                WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN CH.DVZ_ATUT2
                ELSE CH.KPB_ATUT
            END,
        0)
    ) AS ToplamAlacak,
    (SUM(ISNULL(CASE WHEN CH.DOVIZ_KULLAN=1 AND CH.DOVIZ_HES_ISLE=1 THEN CH.DVZ_BTUT2 ELSE CH.KPB_BTUT END,0)))
    -
    (SUM(ISNULL(CASE WHEN CH.DOVIZ_KULLAN=1 AND CH.DOVIZ_HES_ISLE=1 THEN CH.DVZ_ATUT2 ELSE CH.KPB_ATUT END,0)))
    AS Bakiye
FROM
    CARIHR CH
INNER JOIN
    CARI C ON C.BLKODU = CH.BLCRKODU
WHERE
    (@ArananCariUnvani IS NULL OR C.TICARI_UNVANI LIKE '%' + @ArananCariUnvani + '%')
    AND (@ArananParaBirimi IS NULL OR
         (CASE WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN CH.DOVIZ_BIRIMI2 ELSE 'TL' END) = @ArananParaBirimi)
    AND C.AKTIF = 1
    AND CH.SILINDI = 0
GROUP BY
    C.TICARI_UNVANI,
    CASE
        WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN CH.DOVIZ_BIRIMI2
        ELSE 'TL'
    END
ORDER BY
    CariUnvan, ParaBirimi;
    `
  },

  kredi_karti_limitleri: {
    name: "Kredi Kartı Limitleri",
    description: "Kredi kartı limit ve kullanılabilir bakiye raporu",
    parameters: [
      {
        name: "banka_adi",
        type: "string",
        description: "Filtrelemek için banka adı (opsiyonel)",
        required: false
      }
    ],
    query: `
DECLARE @ArananBankaAdi NVARCHAR(100) = NULL;

WITH KrediKartiGuncelBorchlari AS (
    SELECT
        KKH.BLKKKODU AS KartTanimID_Hareketten,
        ISNULL(SUM(ISNULL(KKH.TUTAR_ALACAK, 0) - ISNULL(KKH.TUTAR_BORC, 0)), 0) AS GuncelKartBorcu
    FROM
        KREDI_KARTI KKH
    WHERE
        KKH.SILINDI = 0
    GROUP BY
        KKH.BLKKKODU
),
BankaKrediKartiRaporu AS (
    SELECT
        BA.BANKA_ADI AS BankaAdi,
        ISNULL(BKD.KART_LIMITI, 0) AS KartLimiti,
        ISNULL(KKB.GuncelKartBorcu, 0) AS GuncelBorc
    FROM
        BANKA_KK_DETAY BKD
    INNER JOIN
        BANKA_ADI BA ON BKD.BLMASKODU = BA.BLKODU
    LEFT JOIN
        KrediKartiGuncelBorchlari KKB ON BKD.BLKODU = KKB.KartTanimID_Hareketten
    WHERE
        BKD.AKTIF = 1
        AND ISNULL(BKD.KART_LIMITI, 0) > 0
        AND (@ArananBankaAdi IS NULL OR BA.BANKA_ADI LIKE '%' + @ArananBankaAdi + '%')
),
BankaBazliToplamlar AS (
    SELECT
        BankaAdi,
        SUM(KartLimiti) AS ToplamKKLimit,
        SUM(GuncelBorc) AS ToplamGuncelBorc
    FROM BankaKrediKartiRaporu
    GROUP BY BankaAdi
)
SELECT
    ISNULL(BankaAdi, 'TOPLAM :') AS "TANIM",
    SUM(ToplamKKLimit) AS "KK TOP LİMİTLER",
    SUM(ToplamKKLimit - ToplamGuncelBorc) AS "KK KULLANILABİLİR LİMİTLER"
FROM BankaBazliToplamlar
GROUP BY ROLLUP(BankaAdi)
ORDER BY
    CASE WHEN BankaAdi IS NULL THEN 1 ELSE 0 END,
    BankaAdi;
    `
  },

  doviz_hesaplari_tl_karsiligi: {
    name: "Döviz Hesapları TL Karşılığı",
    description: "Döviz hesaplarının güncel kurdan TL karşılığı raporu",
    parameters: [
      {
        name: "banka_adi",
        type: "string",
        description: "Filtrelemek için banka adı (opsiyonel)",
        required: false
      }
    ],
    query: `
DECLARE @ArananBankaAdi NVARCHAR(100) = NULL;

WITH GuncelSatisKurlari AS (
    SELECT D.DOVIZ_BIRIMI, D.SATIS_FIYATI,
           ROW_NUMBER() OVER(PARTITION BY D.DOVIZ_BIRIMI ORDER BY D.TARIHI DESC, D.BLKODU DESC) AS RN
    FROM DOVIZ D
    WHERE D.TARIHI <= GETDATE() AND D.DOVIZ_BIRIMI IN ('USD','EUR','GBP') AND D.SATIS_FIYATI > 0
),
EnGuncelKurlar AS (
    SELECT DOVIZ_BIRIMI, SATIS_FIYATI FROM GuncelSatisKurlari WHERE RN = 1
),
BankaHesapDovizBakiyeleri AS (
    SELECT BA.BANKA_ADI AS BankaAdi, BHES.HESAP_NO AS HesapNo, BHES.TANIMI AS HesapTanimi,
           BHES.HESAP_TURU AS ParaBirimi,
           dbo.SAYIYUVARLA1(ISNULL(SUM(ISNULL(BHR.TUTAR_ALACAK, 0) - ISNULL(BHR.TUTAR_BORC, 0)), 0), 2, 0) AS BakiyeMatematiksel
    FROM BANKA_HESAP BHES
    INNER JOIN BANKA_ADI BA ON BHES.BLBNKODU = BA.BLKODU
    LEFT JOIN BANKAHR BHR ON BHES.BLKODU = BHR.BLHSKODU AND BHR.SILINDI = 0
    WHERE BHES.CEK_KREDI_HESABI = '0' AND BHES.VADELI = 0 AND BHES.KAPANIS_TARIHI IS NULL
      AND BHES.HESAP_TURU IS NOT NULL AND BHES.HESAP_TURU <> '' AND BHES.HESAP_TURU <> 'TL'
      AND (@ArananBankaAdi IS NULL OR BA.BANKA_ADI LIKE '%' + @ArananBankaAdi + '%')
    GROUP BY BA.BANKA_ADI, BHES.HESAP_NO, BHES.TANIMI, BHES.HESAP_TURU
    HAVING dbo.SAYIYUVARLA1(ISNULL(SUM(ISNULL(BHR.TUTAR_ALACAK, 0) - ISNULL(BHR.TUTAR_BORC, 0)), 0), 2, 0) <> 0
),
DovizBakiyeleriVeTLKarsiliklari AS (
    SELECT BDB.BankaAdi, BDB.HesapNo, BDB.HesapTanimi, BDB.ParaBirimi, BDB.BakiyeMatematiksel,
           EK.SATIS_FIYATI AS GuncelKur,
           dbo.SAYIYUVARLA1(BDB.BakiyeMatematiksel * ISNULL(EK.SATIS_FIYATI, 1), 2, 0) AS TLKarsiligiMatematiksel
    FROM BankaHesapDovizBakiyeleri BDB
    LEFT JOIN EnGuncelKurlar EK ON BDB.ParaBirimi = EK.DOVIZ_BIRIMI
),
CombinedResults AS (
    SELECT
        BankaAdi, HesapNo, HesapTanimi, ParaBirimi,
        CASE WHEN BakiyeMatematiksel < 0 THEN ABS(BakiyeMatematiksel) ELSE BakiyeMatematiksel END AS BakiyeDoviz_Gosterilecek,
        GuncelKur,
        CASE WHEN TLKarsiligiMatematiksel < 0 THEN ABS(TLKarsiligiMatematiksel) ELSE TLKarsiligiMatematiksel END AS BakiyeTL_Karsiligi_Gosterilecek,
        CASE WHEN BakiyeMatematiksel < 0 THEN 'Mevcut Bakiye' WHEN BakiyeMatematiksel > 0 THEN 'Borç Bakiyesi' ELSE 'Sıfır Bakiye' END AS Durum,
        0 AS OrderPriority
    FROM DovizBakiyeleriVeTLKarsiliklari
    UNION ALL
    SELECT
        'TÜM DÖVİZLİ HESAPLARIN TOPLAM TL KARŞILIĞI:' AS BankaAdi,
        NULL AS HesapNo, NULL AS HesapTanimi, NULL AS ParaBirimi,
        NULL AS BakiyeDoviz_Gosterilecek, NULL AS GuncelKur,
        dbo.SAYIYUVARLA1(SUM(CASE WHEN TLKarsiligiMatematiksel < 0 THEN ABS(TLKarsiligiMatematiksel) ELSE 0 END), 2, 0) AS BakiyeTL_Karsiligi_Gosterilecek,
        'Toplam Mevcut (Dövizler)' AS Durum,
        1 AS OrderPriority
    FROM DovizBakiyeleriVeTLKarsiliklari
)
SELECT BankaAdi, HesapNo, HesapTanimi, ParaBirimi, BakiyeDoviz_Gosterilecek, GuncelKur, BakiyeTL_Karsiligi_Gosterilecek, Durum
FROM CombinedResults
ORDER BY OrderPriority, ParaBirimi, BankaAdi;
    `
  },

  kendi_ceklerimiz_detay: {
    name: "Kendi Çeklerimiz Detay",
    description: "Kendi çeklerimizin detaylı raporu",
    parameters: [],
    query: `
WITH CekSenetBaseData AS (
    SELECT
        C.TARIHI,
        C.EVRAK_TURU,
        C.EVRAK_NO,
        C.EVRAK_BANKA,
        C.VADESI,
        C.KPB_TUTARI,
        C.DOVIZ_TUTARI,
        C.EVRAK_DURUMU,
        C.KPBDVZ,
        C.BLKODU AS CEK_SENET_BLKODU
    FROM CEK_SENET C
    OUTER APPLY dbo.CSCARIBUL(C.BLKODU, C.EVRAK_TURU, C.BLCRKODU, C.CIROBLCRKODU, 0, C.EVRAK_DURUMU) CR
    WHERE C.BLKODU > 0
    AND C.TEMINAT_MI = 0
    AND C.EVRAK_TURU IN (1, 2, 3, 4)
    AND C.EVRAK_DURUMU IN (31, 41)
)
SELECT
    FR."Kayıt Tarihi",
    FR."Evrak Türü",
    FR."Evrak No",
    FR."Bankası",
    FR."Vadesi",
    FR."KPB Tutarı",
    FR."Döviz Tutarı",
    FR."Evrak Durumu"
FROM (
    SELECT
        CONVERT(VARCHAR, TARIHI, 104) AS "Kayıt Tarihi",
        CASE EVRAK_TURU
            WHEN 4 THEN 'Kendi Senedim'
            WHEN 3 THEN 'Kendi Çekim'
            ELSE CAST(EVRAK_TURU AS VARCHAR(50))
        END AS "Evrak Türü",
        EVRAK_NO AS "Evrak No",
        EVRAK_BANKA AS "Bankası",
        CONVERT(VARCHAR, VADESI, 104) AS "Vadesi",
        KPB_TUTARI AS "KPB Tutarı",
        DOVIZ_TUTARI AS "Döviz Tutarı",
        CASE EVRAK_DURUMU
            WHEN 31 THEN 'Portföyde'
            WHEN 41 THEN 'Tahsil Edildi'
            ELSE CAST(EVRAK_DURUMU AS VARCHAR(50))
        END AS "Evrak Durumu",
        0 AS IsTotalRow,
        VADESI AS OriginalVadesi
    FROM CekSenetBaseData

    UNION ALL

    SELECT
        NULL AS "Kayıt Tarihi",
        'Genel Toplam' AS "Evrak Türü",
        NULL AS "Evrak No",
        NULL AS "Bankası",
        NULL AS "Vadesi",
        SUM(CASE WHEN KPBDVZ = 1 THEN ISNULL(KPB_TUTARI, 0) ELSE 0 END) AS "KPB Tutarı",
        SUM(CASE WHEN KPBDVZ = 0 THEN ISNULL(DOVIZ_TUTARI, 0) ELSE 0 END) AS "Döviz Tutarı",
        NULL AS "Evrak Durumu",
        1 AS IsTotalRow,
        NULL AS OriginalVadesi
    FROM CekSenetBaseData
) AS FR
ORDER BY
    FR.IsTotalRow,
    FR.OriginalVadesi;
    `
  },

  kendi_ceklerimiz_ozet: {
    name: "Kendi Çeklerimiz Özet",
    description: "Kendi çeklerimizin özet raporu",
    parameters: [],
    query: `
WITH GuncelEURKuru AS (
    SELECT TOP 1
        D.SATIS_FIYATI AS KurDegeri
    FROM
        DOVIZ D
    WHERE
        D.DOVIZ_BIRIMI = 'EUR'
    ORDER BY
        D.TARIHI DESC
),
CekSenetBaseData AS (
    SELECT
        C.TARIHI,
        C.EVRAK_TURU,
        C.EVRAK_NO,
        C.EVRAK_BANKA,
        C.VADESI,
        C.KPB_TUTARI,
        C.DOVIZ_TUTARI,
        C.EVRAK_DURUMU,
        C.KPBDVZ,
        C.BLKODU AS CEK_SENET_BLKODU
    FROM CEK_SENET C
    OUTER APPLY dbo.CSCARIBUL(C.BLKODU, C.EVRAK_TURU, C.BLCRKODU, C.CIROBLCRKODU, 0, C.EVRAK_DURUMU) CR
    WHERE C.BLKODU > 0
    AND C.TEMINAT_MI = 0
    AND C.EVRAK_TURU IN (1, 2, 3, 4)
    AND C.EVRAK_DURUMU IN (31, 41)
),
OzetRaporData AS (
    SELECT
        CASE CSBD.EVRAK_TURU
            WHEN 4 THEN 'Kendi Senedim'
            WHEN 3 THEN 'Kendi Çekim'
            WHEN 2 THEN 'Müşteri Senedi'
            WHEN 1 THEN 'Müşteri Çeki'
            ELSE CAST(CSBD.EVRAK_TURU AS VARCHAR(50))
        END AS "Evrak Türü",
        SUM(CASE WHEN CSBD.KPBDVZ = 1 THEN ISNULL(CSBD.KPB_TUTARI, 0) ELSE 0 END) AS "Toplam KPB Tutarı",
        SUM(CASE WHEN CSBD.KPBDVZ = 0 THEN ISNULL(CSBD.DOVIZ_TUTARI, 0) ELSE 0 END) AS "Toplam Döviz Tutarı",
        (
            SUM(CASE WHEN CSBD.KPBDVZ = 1 THEN ISNULL(CSBD.KPB_TUTARI, 0) ELSE 0 END) +
            (SUM(CASE WHEN CSBD.KPBDVZ = 0 THEN ISNULL(CSBD.DOVIZ_TUTARI, 0) ELSE 0 END) * ISNULL((SELECT KurDegeri FROM GuncelEURKuru), 0))
        ) AS "TL Değeri"
    FROM CekSenetBaseData CSBD
    GROUP BY CSBD.EVRAK_TURU

    UNION ALL

    SELECT
        'Genel Toplam' AS "Evrak Türü",
        SUM(CASE WHEN CSBD.KPBDVZ = 1 THEN ISNULL(CSBD.KPB_TUTARI, 0) ELSE 0 END) AS "Toplam KPB Tutarı",
        SUM(CASE WHEN CSBD.KPBDVZ = 0 THEN ISNULL(CSBD.DOVIZ_TUTARI, 0) ELSE 0 END) AS "Toplam Döviz Tutarı",
        (
            SUM(CASE WHEN CSBD.KPBDVZ = 1 THEN ISNULL(CSBD.KPB_TUTARI, 0) ELSE 0 END) +
            (SUM(CASE WHEN CSBD.KPBDVZ = 0 THEN ISNULL(CSBD.DOVIZ_TUTARI, 0) ELSE 0 END) * ISNULL((SELECT KurDegeri FROM GuncelEURKuru), 0))
        ) AS "TL Değeri"
    FROM CekSenetBaseData CSBD
)
SELECT
    ORD."Evrak Türü",
    ORD."Toplam KPB Tutarı",
    ORD."Toplam Döviz Tutarı",
    ORD."TL Değeri"
FROM OzetRaporData ORD
ORDER BY
    CASE WHEN ORD."Evrak Türü" = 'Genel Toplam' THEN 1 ELSE 0 END,
    ORD."Evrak Türü";
    `
  },



  kasa_bakiye_detay: {
    name: "Kasa Bakiye Detay",
    description: "Kasa bakiyelerinin detaylı raporu",
    parameters: [],
    query: `
WITH GuncelEURKuru AS (
    SELECT TOP 1
        ISNULL(SATIS_FIYATI, 1.0) AS KurEUR_Satis
    FROM
        DOVIZ
    WHERE
        DOVIZ_BIRIMI = 'EUR'
        AND SATIS_FIYATI > 0
        AND TARIHI <= GETDATE()
    ORDER BY
        TARIHI DESC, BLKODU DESC
),
KasaBazindaBakiye AS (
    SELECT
        K.KASA_ADI,
        SUM(
            CASE
                WHEN H.KPBDVZ = 1 THEN ISNULL(H.KPB_GLTUT, 0) - ISNULL(H.KPB_GDTUT, 0)
                ELSE 0
            END
        ) AS NetTLBakiye_Ham,
        SUM(
            CASE
                WHEN H.KPBDVZ = 0 AND H.DOVIZ_KULLAN = 1 AND H.DOVIZ_BIRIMI = 'EUR' THEN ISNULL(H.DVZ_GLTUT, 0) - ISNULL(H.DVZ_GDTUT, 0)
                ELSE 0
            END
        ) AS NetEURBakiye_Ham
    FROM
        KASAHR H
    JOIN
        KASA K ON K.KASA_ADI = H.KASA_ADI
    WHERE
        H.BLKODU > 0
        AND H.KASA_ADI IN ('NAKİT', 'AHMET KK. ', 'HAKAN KK.', 'ŞİRKET KK. OFİS')
        AND K.AKTIF = 1
        AND H.TARIHI <= GETDATE()
        AND H.SILINDI = 0
    GROUP BY
        K.KASA_ADI
),
RaporVerisi AS (
    SELECT
        KB.KASA_ADI,
        KB.NetTLBakiye_Ham,
        KB.NetEURBakiye_Ham,
        (KB.NetEURBakiye_Ham * ISNULL((SELECT KurEUR_Satis FROM GuncelEURKuru), 1.0)) AS NetEUR_TL_Esdegeri_Ham
    FROM
        KasaBazindaBakiye KB
)
SELECT
    RV.KASA_ADI AS "Kasa Adı",
    dbo.SAYIYUVARLA1(RV.NetTLBakiye_Ham, 2, 0) AS "Net TL Bakiye",
    dbo.SAYIYUVARLA1(RV.NetEURBakiye_Ham, 2, 0) AS "Net EUR Bakiye",
    dbo.SAYIYUVARLA1(RV.NetEUR_TL_Esdegeri_Ham, 2, 0) AS "EUR Bakiye (TL Karşılığı)",
    dbo.SAYIYUVARLA1(RV.NetTLBakiye_Ham + RV.NetEUR_TL_Esdegeri_Ham, 2, 0) AS "Kasa Toplam Bakiye (TL)",
    0 AS SiraTipi
FROM
    RaporVerisi RV

UNION ALL

SELECT
    'Genel Toplam' AS "Kasa Adı",
    dbo.SAYIYUVARLA1(SUM(RV.NetTLBakiye_Ham), 2, 0) AS "Net TL Bakiye",
    dbo.SAYIYUVARLA1(SUM(RV.NetEURBakiye_Ham), 2, 0) AS "Net EUR Bakiye",
    dbo.SAYIYUVARLA1(SUM(RV.NetEUR_TL_Esdegeri_Ham), 2, 0) AS "EUR Bakiye (TL Karşılığı)",
    dbo.SAYIYUVARLA1(SUM(RV.NetTLBakiye_Ham + RV.NetEUR_TL_Esdegeri_Ham), 2, 0) AS "Kasa Toplam Bakiye (TL)",
    1 AS SiraTipi
FROM
    RaporVerisi RV
ORDER BY
    SiraTipi, "Kasa Adı";
    `
  },

  teklif_raporu: {
    name: "Teklif Raporu",
    description: "Cari ünvanına göre teklif raporu",
    parameters: [
      {
        name: "cari_unvani",
        type: "string",
        description: "Aranacak cari ünvanı",
        required: true
      },
      {
        name: "teklif_durumu",
        type: "string",
        description: "Teklif durumu kodu (opsiyonel)",
        required: false
      },
      {
        name: "teklif_aciklamasi",
        type: "string",
        description: "Teklif açıklaması (opsiyonel)",
        required: false
      }
    ],
    query: `
DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;
DECLARE @TeklifDurumu NVARCHAR(50) = NULL;
DECLARE @TeklifAciklamasi NVARCHAR(255) = NULL;

WITH TeklifIlkIskonto AS (
    SELECT
        TH.BLTKKODU,
        TH.ISK_ORAN_1,
        ROW_NUMBER() OVER(PARTITION BY TH.BLTKKODU ORDER BY TH.SIRA_NO ASC, TH.BLKODU ASC) as rn
    FROM TEKLIFHR TH
    WHERE TH.ISK_ORAN_1 IS NOT NULL AND TH.ISK_ORAN_1 > 0
)
SELECT
    T.TEKLIF_NO AS TeklifNo,
    T.TARIHI AS TeklifTarihi,
    T.TICARI_UNVANI AS CariUnvan,
    TDT.TANIMI AS TeklifDurumu,
    T.ACIKLAMA AS TeklifAciklamasi,
    ISNULL(TII.ISK_ORAN_1, 0) AS TeklifIskontoOrani,
    CASE WHEN T.DOVIZ_KULLAN = 1 THEN T.TOPLAM_GENEL_DVZ ELSE T.TOPLAM_GENEL_KPB END AS GenelToplam,
    CASE WHEN T.DOVIZ_KULLAN = 1 THEN T.DOVIZ_BIRIMI ELSE 'TL' END AS ParaBirimi,
    T.KAYDEDEN AS KaydedenKullanici,
    T.DEGISTIRME_TARIHI AS SonDegistirmeTarihi
FROM
    TEKLIF T
LEFT JOIN
    CARI C ON C.BLKODU = T.BLCRKODU
LEFT JOIN
    TEKLIF_DURUM_TANIM TDT ON T.TEKLIF_DURUMU = TDT.KODU
LEFT JOIN
    TeklifIlkIskonto TII ON TII.BLTKKODU = T.BLKODU AND TII.rn = 1
WHERE
    T.BLKODU > 0
    AND T.SILINDI = 0
    AND T.TEKLIF_TURU IN (1,3)
    AND (@ArananCariUnvani IS NULL OR T.TICARI_UNVANI LIKE '%' + @ArananCariUnvani + '%')
    AND (@TeklifAciklamasi IS NULL OR T.ACIKLAMA LIKE '%' + @TeklifAciklamasi + '%')
    AND (C.BLKODU IS NULL OR C.GRUBU NOT IN ('6 - PERSO','DİĞER'))
    AND (@TeklifDurumu IS NULL OR TDT.KODU = @TeklifDurumu OR T.TEKLIF_DURUMU = @TeklifDurumu)
ORDER BY
    T.DEGISTIRME_TARIHI DESC, T.KAYIT_TARIHI DESC;
    `
  },





  teklif_detay: {
    name: "Teklif Detay",
    description: "Teklif numarasına göre teklif detayları",
    parameters: [
      {
        name: "teklif_no",
        type: "string",
        description: "Teklif numarası",
        required: true
      }
    ],
    query: `
DECLARE @TeklifNo NVARCHAR(50) = NULL;

WITH TeklifBLKodu AS (
    SELECT BLKODU FROM TEKLIF WHERE TEKLIF_NO = @TeklifNo AND SILINDI = 0
)
SELECT
    T.TEKLIF_NO AS AnaTeklifNo,
    T.ACIKLAMA AS TeklifGenelAciklama,
    T.TICARI_UNVANI AS CariUnvan,
    TDT.TANIMI AS TeklifDurumu,
    TH.STOKKODU AS UrunKodu,
    TH.STOK_ADI AS UrunAdi,
    TH.MIKTARI AS Miktar,
    TH.BIRIMI AS Birim,
    CASE WHEN T.DOVIZ_KULLAN = 1 THEN TH.DVZ_FIYATI ELSE TH.KPB_FIYATI END AS BrutBirimFiyat,
    TH.ISK_ORAN_1 AS IskontoOrani1,
    TH.ISK_ORAN_2 AS IskontoOrani2,
    CASE WHEN T.DOVIZ_KULLAN = 1 THEN TH.DVZ_IND_FIYAT ELSE TH.KPB_IND_FIYAT END AS IndirimliBirimFiyat_KDVHaric,
    CASE WHEN T.DOVIZ_KULLAN = 1 THEN TH.DVZ_IND_TUTAR ELSE TH.KPB_IND_TUTAR END AS IndirimliSatirTutar_KDVHaric,
    TH.KDV_ORANI AS KDVOrani,
    CASE WHEN T.DOVIZ_KULLAN = 1 THEN TH.DVZ_KDVLI_TUTAR ELSE TH.KPB_KDVLI_TUTAR END AS SatirGenelToplam_KDVli,
    CASE WHEN T.DOVIZ_KULLAN = 1 THEN T.DOVIZ_BIRIMI ELSE 'TL' END AS ParaBirimi
FROM
    TEKLIFHR TH
INNER JOIN
    TEKLIF T ON TH.BLTKKODU = T.BLKODU
LEFT JOIN
    TEKLIF_DURUM_TANIM TDT ON T.TEKLIF_DURUMU = TDT.KODU
INNER JOIN
    TeklifBLKodu TB ON T.BLKODU = TB.BLKODU
ORDER BY
    TH.BLKODU;
    `
  },

  cari_hareket: {
    name: "Cari Hareket",
    description: "Cari hesap hareket raporu",
    parameters: [
      {
        name: "cari_unvani",
        type: "string",
        description: "Aranacak cari ünvanı",
        required: true
      },
      {
        name: "baslangic_tarihi",
        type: "string",
        description: "Başlangıç tarihi (YYYY-MM-DD)",
        required: false
      },
      {
        name: "bitis_tarihi",
        type: "string",
        description: "Bitiş tarihi (YYYY-MM-DD)",
        required: false
      }
    ],
    query: `
DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;
DECLARE @BaslangicTarihi DATE = NULL;
DECLARE @BitisTarihi DATE = NULL;

-- Varsayılan tarih aralığı (son 1 yıl)
IF @BaslangicTarihi IS NULL
    SET @BaslangicTarihi = DATEADD(YEAR, -1, GETDATE());

IF @BitisTarihi IS NULL
    SET @BitisTarihi = GETDATE();

WITH CariSecim AS (
    SELECT BLKODU FROM CARI
    WHERE (@ArananCariUnvani IS NULL OR TICARI_UNVANI LIKE '%' + @ArananCariUnvani + '%')
    AND AKTIF = 1 AND SILINDI = 0
)
SELECT
    CH.TARIHI AS IslemTarihi,
    CH.EVRAK_NO AS BelgeNo,
    CH.ACIKLAMA AS Aciklama,
    CASE CH.ISLEM_TURU
        WHEN 8 THEN 'Senet'
        WHEN 9 THEN 'Fatura'
        WHEN 12 THEN 'Virman'
        WHEN 4 THEN 'Dekont'
        WHEN 13 THEN 'Tahakkuk'
        WHEN 5 THEN 'Kredi Kartı'
        ELSE 'Diğer (' + CAST(CH.ISLEM_TURU AS VARCHAR(10)) + ')'
    END AS IslemTuru,
    CASE WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN CH.DOVIZ_BIRIMI2 ELSE 'TL' END AS ParaBirimi,
    CASE WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN ISNULL(CH.DVZ_BTUT2, 0) ELSE ISNULL(CH.KPB_BTUT, 0) END AS BorcTutari,
    CASE WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN ISNULL(CH.DVZ_ATUT2, 0) ELSE ISNULL(CH.KPB_ATUT, 0) END AS AlacakTutari,
    SUM(CASE WHEN CH.DOVIZ_KULLAN = 1 AND CH.DOVIZ_HES_ISLE = 1 THEN ISNULL(CH.DVZ_BTUT2, 0) - ISNULL(CH.DVZ_ATUT2, 0)
             ELSE ISNULL(CH.KPB_BTUT, 0) - ISNULL(CH.KPB_ATUT, 0) END
    ) OVER (PARTITION BY C.BLKODU, CASE WHEN CH.DOVIZ_KULLAN=1 AND CH.DOVIZ_HES_ISLE=1 THEN CH.DOVIZ_BIRIMI2 ELSE 'TL' END
            ORDER BY CH.TARIHI, CH.BLKODU ROWS UNBOUNDED PRECEDING) AS SatirBakiyesi
FROM CARIHR CH
INNER JOIN CARI C ON C.BLKODU = CH.BLCRKODU
INNER JOIN CariSecim CS ON C.BLKODU = CS.BLKODU
WHERE CH.SILINDI = 0
AND CH.TARIHI BETWEEN @BaslangicTarihi AND @BitisTarihi
ORDER BY ParaBirimi, CH.TARIHI, CH.BLKODU;
    `
  },





  // Yeni bakiye sorguları - guncelleme.txt'den (doğru SQL kodları)

  // Yeni "Bakiyeler Listesi" sorgusu - YENI.md'den
  bakiyeler_listesi: {
    name: "Bakiyeler Listesi",
    description: "Parametreli bakiyeler listesi - grup, ticari ünvan ve bakiye durumu filtreleme",
    parameters: [
      {
        name: "grup_filtresi",
        type: "string",
        description: "Grup filtresi (opsiyonel) - örn: '1 - MÜŞTERİ'",
        required: false
      },
      {
        name: "ticari_unvan_filtresi",
        type: "string",
        description: "Ticari ünvan filtresi (opsiyonel) - kısmi arama",
        required: false
      },
      {
        name: "bakiye_durumu_filtresi",
        type: "string",
        description: "Bakiye durumu filtresi (opsiyonel) - 'borclu', 'alacakli', 'sifir'",
        required: false
      }
    ],
    query: `
    -- === YENİ BAKİYELER LİSTESİ - PARAMETRELİ FİLTRELEME (ORİJİNAL YAPI KORUNDU) ===

    -- Parametre tanımlamaları
    DECLARE @GrupFiltresi NVARCHAR(100) = NULL;
    DECLARE @TicariUnvanFiltresi NVARCHAR(255) = NULL;
    DECLARE @BakiyeDurumuFiltresi NVARCHAR(20) = NULL;

    -- Rapor için gerekli parametreler
    DECLARE @CARISART_PARAM_FILTER NVARCHAR(MAX);
    DECLARE @CARIHRSART_PARAM_FILTER NVARCHAR(2000);
    DECLARE @ILKISLEMTARIHI_PARAM VARCHAR(22);
    DECLARE @DONEMSEL_BAKIYE_PARAM SMALLINT;
    DECLARE @DOVIZ_KULLAN_PARAM SMALLINT;
    DECLARE @DONEMSEL_VALOR_PARAM SMALLINT;
    DECLARE @VALOR_FIELD_PARAM VARCHAR(100);
    DECLARE @BUGUN_TARIHI_STR_PARAM VARCHAR(25);
    DECLARE @BKY_ODEME_TARIHI_STR_PARAM VARCHAR(25);
    DECLARE @DNM_VALOR_DRM_PARAM SMALLINT;

    -- Varsayılan değerler
    SET @CARISART_PARAM_FILTER = N' AND (C.AKTIF=1 OR C.AKTIF IS NULL) ';
    SET @CARIHRSART_PARAM_FILTER = N'';
    SET @ILKISLEMTARIHI_PARAM = '';
    SET @DONEMSEL_BAKIYE_PARAM = 0;
    SET @DOVIZ_KULLAN_PARAM = 1;
    SET @DONEMSEL_VALOR_PARAM = 0;
    SET @VALOR_FIELD_PARAM = 'VADESI';
    SET @BUGUN_TARIHI_STR_PARAM = CONVERT(VARCHAR(25), GETDATE(), 104);
    SET @BKY_ODEME_TARIHI_STR_PARAM = CONVERT(VARCHAR(25), GETDATE(), 104);
    SET @DNM_VALOR_DRM_PARAM = 0;

    DECLARE @KPBHESAP_AYAR VARCHAR(4), @KPBOND_AYAR_STR VARCHAR(1), @DVZOND_AYAR_STR VARCHAR(1), @KPBOND_AYAR_INT SMALLINT;
    DECLARE @ILKTARIH_CONVERTED DATETIME, @BUGUN_TARIHI_CONVERTED DATETIME;
    DECLARE @GCC1_TARIH_PARAM DATETIME, @GCC2_TARIH_PARAM DATETIME;

    IF (@ILKISLEMTARIHI_PARAM <> '' AND @ILKISLEMTARIHI_PARAM IS NOT NULL) SET @ILKTARIH_CONVERTED = CONVERT(DATETIME, @ILKISLEMTARIHI_PARAM, 104);
    ELSE SET @ILKTARIH_CONVERTED = CAST(0 AS DATETIME);

    IF (@BUGUN_TARIHI_STR_PARAM <> '' AND @BUGUN_TARIHI_STR_PARAM IS NOT NULL) SET @BUGUN_TARIHI_CONVERTED = CONVERT(DATETIME, @BUGUN_TARIHI_STR_PARAM, 104);
    ELSE SET @BUGUN_TARIHI_CONVERTED = GETDATE();

    IF (@ILKISLEMTARIHI_PARAM <> '' AND @ILKISLEMTARIHI_PARAM IS NOT NULL) SET @GCC1_TARIH_PARAM = CONVERT(DATETIME, @ILKISLEMTARIHI_PARAM, 104);
    ELSE SET @GCC1_TARIH_PARAM = NULL;
    IF (@BKY_ODEME_TARIHI_STR_PARAM <> '' AND @BKY_ODEME_TARIHI_STR_PARAM IS NOT NULL) SET @GCC2_TARIH_PARAM = CONVERT(DATETIME, @BKY_ODEME_TARIHI_STR_PARAM, 104);
    ELSE SET @GCC2_TARIH_PARAM = NULL;

    SELECT @KPBHESAP_AYAR = PARA_SIMGESI,
        @KPBOND_AYAR_STR = CAST(COALESCE(PARA_HASSASIYETI,0) AS VARCHAR(1)),
        @DVZOND_AYAR_STR = CAST(COALESCE(DOVIZ_HASSASIYET,0) AS VARCHAR(1))
    FROM AYAR;
    SET @KPBOND_AYAR_INT = CAST(@KPBOND_AYAR_STR AS SMALLINT);

    WITH
    RawBakiyeData AS (
        SELECT
            CH.BLCRKODU AS JoinKey_Blkodu,
            @KPBHESAP_AYAR AS HESAP,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI < @ILKTARIH_CONVERTED THEN CH.KPB_BTUT ELSE 0 END, @KPBOND_AYAR_INT, 0) AS DV_BRC,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI < @ILKTARIH_CONVERTED THEN CH.KPB_ATUT ELSE 0 END, @KPBOND_AYAR_INT, 0) AS DV_ALC,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI >= @ILKTARIH_CONVERTED THEN CH.KPB_BTUT ELSE 0 END, @KPBOND_AYAR_INT, 0) AS BRC,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI >= @ILKTARIH_CONVERTED THEN CH.KPB_ATUT ELSE 0 END, @KPBOND_AYAR_INT, 0) AS ALC,
            CH.TARIHI AS TARIHI_RAW,
            CH.VADESI AS VADESI_RAW,
            DATEADD(DAY,DATEDIFF(DAY,0,CH.VADESI),0) AS VFIELD_RAW
        FROM CARIHR CH
        WHERE CH.SILINDI=0 AND (CH.DOVIZ_KULLAN<>1 OR CH.DOVIZ_HES_ISLE <> 1)
        AND (@DONEMSEL_BAKIYE_PARAM = 0 OR (@DONEMSEL_BAKIYE_PARAM = 1 AND (CH.KP_DEVIR=0 OR CH.KP_DEVIR IS NULL)))

        UNION ALL

        SELECT
            CH.BLCRKODU AS JoinKey_Blkodu,
            CH.DOVIZ_BIRIMI2 AS HESAP,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI < @ILKTARIH_CONVERTED THEN CH.DVZ_BTUT2 ELSE 0 END, @KPBOND_AYAR_INT, 0) AS DV_BRC,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI < @ILKTARIH_CONVERTED THEN CH.DVZ_ATUT2 ELSE 0 END, @KPBOND_AYAR_INT, 0) AS DV_ALC,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI >= @ILKTARIH_CONVERTED THEN CH.DVZ_BTUT2 ELSE 0 END, @KPBOND_AYAR_INT, 0) AS BRC,
            dbo.SAYIYUVARLA1(CASE WHEN CH.TARIHI >= @ILKTARIH_CONVERTED THEN CH.DVZ_ATUT2 ELSE 0 END, @KPBOND_AYAR_INT, 0) AS ALC,
            CH.TARIHI AS TARIHI_RAW,
            CH.VADESI AS VADESI_RAW,
            DATEADD(DAY,DATEDIFF(DAY,0,CH.VADESI),0) AS VFIELD_RAW
        FROM CARIHR CH
        WHERE CH.SILINDI=0 AND CH.DOVIZ_KULLAN=1 AND CH.DOVIZ_HES_ISLE=1 AND @DOVIZ_KULLAN_PARAM = 1
        AND (@DONEMSEL_BAKIYE_PARAM = 0 OR (@DONEMSEL_BAKIYE_PARAM = 1 AND (CH.KP_DEVIR=0 OR CH.KP_DEVIR IS NULL)))
    ),
    AggregatedBakiye AS (
        SELECT
            JoinKey_Blkodu,
            HESAP,
            SUM(DV_BRC) AS TotalDevirBrc, SUM(DV_ALC) AS TotalDevirAlc,
            SUM(BRC) AS TotalDonemBrc, SUM(ALC) AS TotalDonemAlc,
            MAX(TARIHI_RAW) AS SONISLEM_TARIHI, MAX(VADESI_RAW) AS SONVADE_TARIHI
        FROM RawBakiyeData
        GROUP BY JoinKey_Blkodu, HESAP
    ),
    FinalBakiye AS (
        SELECT
            ag.JoinKey_Blkodu, ag.HESAP,
            CASE
                WHEN @DONEMSEL_BAKIYE_PARAM = 1 THEN COALESCE(cv.BRC_TUTARI, ag.TotalDevirBrc)
                WHEN ag.TotalDevirBrc > ag.TotalDevirAlc THEN ag.TotalDevirBrc - ag.TotalDevirAlc
                ELSE 0
            END AS FinalNetDevirBrc,
            CASE
                WHEN @DONEMSEL_BAKIYE_PARAM = 1 THEN COALESCE(cv.ALC_TUTARI, ag.TotalDevirAlc)
                WHEN ag.TotalDevirAlc >= ag.TotalDevirBrc THEN ag.TotalDevirAlc - ag.TotalDevirBrc
                ELSE 0
            END AS FinalNetDevirAlc,
            ag.TotalDonemBrc, ag.TotalDonemAlc,
            ag.SONISLEM_TARIHI, ag.SONVADE_TARIHI
        FROM AggregatedBakiye ag
        LEFT JOIN CARIHR_VALOR cv ON @DONEMSEL_BAKIYE_PARAM = 1 AND ag.JoinKey_Blkodu = cv.BLCRKODU
                                AND ag.HESAP = (CASE WHEN cv.KPBDVZ=1 THEN @KPBHESAP_AYAR ELSE cv.DOVIZ_BIRIMI END)
    ),
    CalculatedData AS (
        SELECT
            f.JoinKey_Blkodu, f.HESAP,
            f.TotalDonemBrc + f.FinalNetDevirBrc AS TPL_BRC,
            f.TotalDonemAlc + f.FinalNetDevirAlc AS TPL_ALC,
            mb.BAKIYE AS TPL_BKY,
            mb.BTR AS TPL_BTR, -- 1: Borçlu, 2: Alacaklı, 0: Sıfır
            f.SONISLEM_TARIHI, f.SONVADE_TARIHI
        FROM FinalBakiye f
        CROSS APPLY dbo.METKANAI_BAKIYEDEGERBUL(f.TotalDonemBrc + f.FinalNetDevirBrc, f.TotalDonemAlc + f.FinalNetDevirAlc, @KPBOND_AYAR_INT) mb
    ),
    ReportDetails AS (
        SELECT
            C.GRUBU,
            C.TICARI_UNVANI,
            BKY_TL.TPL_BRC AS TPL_BRC_TL,
            BKY_TL.TPL_ALC AS TPL_ALC_TL,
            BKY_TL.TPL_BKY AS TPL_BKY_TL,
            BKY_TL.TPL_BTR AS TPL_BTR_TL_Original,
            CASE WHEN C.DOVIZ_BIRIMI = 'EUR' AND BKY_DVZ.HESAP = 'EUR' THEN BKY_DVZ.TPL_BRC ELSE NULL END AS TPL_BRC_EUR,
            CASE WHEN C.DOVIZ_BIRIMI = 'EUR' AND BKY_DVZ.HESAP = 'EUR' THEN BKY_DVZ.TPL_ALC ELSE NULL END AS TPL_ALC_EUR,
            CASE WHEN C.DOVIZ_BIRIMI = 'EUR' AND BKY_DVZ.HESAP = 'EUR' THEN BKY_DVZ.TPL_BKY ELSE NULL END AS TPL_BKY_EUR,
            CASE WHEN C.DOVIZ_BIRIMI = 'EUR' AND BKY_DVZ.HESAP = 'EUR' THEN BKY_DVZ.TPL_BTR ELSE NULL END AS TPL_BTR_EUR_Original,
            C.ARA_GRUBU,
            TRH.SONVADE_TARIHI,
            TRH.SONISLEM_TARIHI,
            C.BLKODU
        FROM CARI C
        LEFT JOIN CalculatedData BKY_TL ON C.BLKODU = BKY_TL.JoinKey_Blkodu AND BKY_TL.HESAP = @KPBHESAP_AYAR
        LEFT JOIN CalculatedData BKY_DVZ ON C.BLKODU = BKY_DVZ.JoinKey_Blkodu AND BKY_DVZ.HESAP = C.DOVIZ_BIRIMI AND BKY_DVZ.HESAP = 'EUR'
        LEFT JOIN (
            SELECT JoinKey_Blkodu, MAX(SONISLEM_TARIHI) AS SONISLEM_TARIHI, MAX(SONVADE_TARIHI) AS SONVADE_TARIHI
            FROM CalculatedData GROUP BY JoinKey_Blkodu
        ) TRH ON C.BLKODU = TRH.JoinKey_Blkodu
        WHERE C.BLKODU > 0
        AND (C.AKTIF=1 OR C.AKTIF IS NULL)
        -- DÜZELTME: Parametreli filtreler (YENI.md'deki format)
        AND (@GrupFiltresi IS NULL OR @GrupFiltresi = '' OR C.GRUBU = @GrupFiltresi)
        AND (@TicariUnvanFiltresi IS NULL OR @TicariUnvanFiltresi = '' OR C.TICARI_UNVANI LIKE '%' + @TicariUnvanFiltresi + '%')
        AND (
            BKY_TL.TPL_BKY IS NOT NULL OR
            (C.DOVIZ_BIRIMI = 'EUR' AND BKY_DVZ.HESAP = 'EUR' AND BKY_DVZ.TPL_BKY IS NOT NULL)
        )
        -- DÜZELTME: Bakiye durumu filtresi (TL öncelikli, TL sıfır/boşsa EUR'a bak)
        AND (
            @BakiyeDurumuFiltresi IS NULL OR @BakiyeDurumuFiltresi = '' OR
            (@BakiyeDurumuFiltresi = 'borclu' AND (
                BKY_TL.TPL_BTR = 1 OR
                ((BKY_TL.TPL_BTR IS NULL OR BKY_TL.TPL_BTR = 0 OR BKY_TL.TPL_BTR = 2) AND C.DOVIZ_BIRIMI = 'EUR' AND BKY_DVZ.HESAP = 'EUR' AND BKY_DVZ.TPL_BTR = 1)
            )) OR
            (@BakiyeDurumuFiltresi = 'alacakli' AND (
                BKY_TL.TPL_BTR = 2 OR
                ((BKY_TL.TPL_BTR IS NULL OR BKY_TL.TPL_BTR = 0 OR BKY_TL.TPL_BTR = 1) AND C.DOVIZ_BIRIMI = 'EUR' AND BKY_DVZ.HESAP = 'EUR' AND BKY_DVZ.TPL_BTR = 2)
            )) OR
            (@BakiyeDurumuFiltresi = 'sifir' AND (
                (BKY_TL.TPL_BTR = 0 OR BKY_TL.TPL_BTR IS NULL) AND
                (BKY_DVZ.TPL_BTR = 0 OR BKY_DVZ.TPL_BTR IS NULL OR BKY_DVZ.TPL_BTR IS NULL)
            ))
        )
    ),
    FinalReportSet AS (
        SELECT
            1 AS MasterSortKey,
            RD.SONISLEM_TARIHI AS OrderDate,
            RD.TICARI_UNVANI AS OrderName,
            RD.GRUBU AS "Grubu",
            RD.TICARI_UNVANI AS "Ticari Ünvanı",
            RD.TPL_BRC_TL AS "Toplam Borç TL",
            RD.TPL_ALC_TL AS "Toplam Alacak TL",
            RD.TPL_BKY_TL AS "TL Bakiye",
            CASE RD.TPL_BTR_TL_Original
                WHEN 1 THEN 'Borçlu'
                WHEN 2 THEN 'Alacaklı'
                WHEN 0 THEN 'SIFIR'
                ELSE NULL
            END AS "B/A",
            RD.TPL_BRC_EUR AS "Toplam Borç EUR",
            RD.TPL_ALC_EUR AS "Toplam Alacak EUR",
            RD.TPL_BKY_EUR AS "EUR Bakiye",
            CASE RD.TPL_BTR_EUR_Original
                WHEN 1 THEN 'Borçlu'
                WHEN 2 THEN 'Alacaklı'
                WHEN 0 THEN 'SIFIR'
                ELSE NULL
            END AS "B/A EUR",
            RD.ARA_GRUBU AS "Ara Grubu",
            CONVERT(VARCHAR(10), RD.SONVADE_TARIHI, 104) AS "Son Vade Tarihi",
            CONVERT(VARCHAR(10), RD.SONISLEM_TARIHI, 104) AS "Son İşlem Tarihi"
        FROM ReportDetails RD

        UNION ALL

        SELECT
            2 AS MasterSortKey,
            NULL AS OrderDate,
            NULL AS OrderName,
            'GENEL TOPLAMLAR' AS "Grubu",
            NULL AS "Ticari Ünvanı",
            SUM(ISNULL(RD.TPL_BRC_TL, 0)) AS "Toplam Borç TL",
            SUM(ISNULL(RD.TPL_ALC_TL, 0)) AS "Toplam Alacak TL",
            SUM(ISNULL(RD.TPL_BRC_TL, 0)) - SUM(ISNULL(RD.TPL_ALC_TL, 0)) AS "TL Bakiye",
            CASE
                WHEN SUM(ISNULL(RD.TPL_BRC_TL, 0)) - SUM(ISNULL(RD.TPL_ALC_TL, 0)) > 0 THEN 'Borçlu'
                WHEN SUM(ISNULL(RD.TPL_BRC_TL, 0)) - SUM(ISNULL(RD.TPL_ALC_TL, 0)) < 0 THEN 'Alacaklı'
                ELSE 'SIFIR'
            END AS "B/A",
            SUM(ISNULL(RD.TPL_BRC_EUR, 0)) AS "Toplam Borç EUR",
            SUM(ISNULL(RD.TPL_ALC_EUR, 0)) AS "Toplam Alacak EUR",
            SUM(ISNULL(RD.TPL_BRC_EUR, 0)) - SUM(ISNULL(RD.TPL_ALC_EUR, 0)) AS "EUR Bakiye",
            CASE
                WHEN SUM(ISNULL(RD.TPL_BRC_EUR, 0)) - SUM(ISNULL(RD.TPL_ALC_EUR, 0)) > 0 THEN 'Borçlu'
                WHEN SUM(ISNULL(RD.TPL_BRC_EUR, 0)) - SUM(ISNULL(RD.TPL_ALC_EUR, 0)) < 0 THEN 'Alacaklı'
                ELSE 'SIFIR'
            END AS "B/A EUR",
            NULL AS "Ara Grubu",
            NULL AS "Son Vade Tarihi",
            NULL AS "Son İşlem Tarihi"
        FROM ReportDetails RD
        HAVING COUNT(RD.BLKODU) > 0 OR SUM(ISNULL(RD.TPL_BRC_TL,0)) <> 0 OR SUM(ISNULL(RD.TPL_ALC_TL,0)) <> 0 -- Genel toplamlar satırının boş gelmemesi için
    )
    SELECT
        "Grubu",
        "Ticari Ünvanı",
        "Toplam Borç TL",
        "Toplam Alacak TL",
        "TL Bakiye",
        "B/A",
        "Toplam Borç EUR",
        "Toplam Alacak EUR",
        "EUR Bakiye",
        "B/A EUR",
        "Ara Grubu",
        "Son Vade Tarihi",
        "Son İşlem Tarihi"
    FROM FinalReportSet
    ORDER BY MasterSortKey ASC, OrderDate DESC, OrderName ASC;
    `
  }

};

// MCP Sunucusunu başlat
const server = new Server(
  {
    name: "wolvoks-erp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Araçları listele
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.entries(predefinedQueries).map(([key, query]) => ({
      name: key,
      description: query.description,
      inputSchema: {
        type: "object",
        properties: {
          api_key: {
            type: "string",
            description: "API anahtarı (gerekli)"
          },
          ...query.parameters.reduce((acc, param) => {
            acc[param.name] = {
              type: param.type,
              description: param.description
            };
            return acc;
          }, {} as any)
        },
        required: ["api_key", ...query.parameters.filter(p => p.required).map(p => p.name)]
      }
    }))
  };
});

// Araç çağrısını işle
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Arguments kontrolü
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, "Geçersiz parametreler");
    }

    // API Key kontrolü
    const apiKey = (args as Record<string, any>).api_key as string;
    if (!apiKey) {
      throw new McpError(ErrorCode.InvalidParams, "API anahtarı gerekli");
    }

    const user = validateApiKey(apiKey);
    if (!user) {
      throw new McpError(ErrorCode.InvalidParams, "Geçersiz API anahtarı");
    }

    // Rate limiting kontrolü
    if (!checkRateLimit(user)) {
      throw new McpError(ErrorCode.InvalidParams, "Rate limit aşıldı. Lütfen daha sonra tekrar deneyin.");
    }

    // Yetki kontrolü
    if (!user.allowedQueries.includes("*") && !user.allowedQueries.includes(name)) {
      throw new McpError(ErrorCode.InvalidParams, "Bu sorguyu çalıştırma yetkiniz yok");
    }

    // Sorgu kontrolü
    const queryDef = predefinedQueries[name as keyof typeof predefinedQueries];
    if (!queryDef) {
      throw new McpError(ErrorCode.InvalidParams, `Bilinmeyen sorgu: ${name}`);
    }

    // Veritabanı bağlantısını kontrol et
    if (!pool) {
      await initializeDatabase();
    }

    // SQL sorgusunu çalıştır
    const request = pool!.request();

    // Sorguyu dinamik olarak oluştur
    let finalQuery = queryDef.query;

    // Özel parametre işleme
    if (name === 'banka_bakiyeleri') {
      const bankaAdi = (args as Record<string, any>).banka_adi;
      const paraBirimi = (args as Record<string, any>).para_birimi;

      if (bankaAdi && bankaAdi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananBankaAdiParam NVARCHAR(100) = NULL;',
          `DECLARE @ArananBankaAdiParam NVARCHAR(100) = '${bankaAdi.replace(/'/g, "''")}';`
        );
      }

      if (paraBirimi && paraBirimi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananParaBirimi NVARCHAR(10) = NULL;',
          `DECLARE @ArananParaBirimi NVARCHAR(10) = '${paraBirimi.replace(/'/g, "''")}';`
        );
      }
    } else if (name === 'cari_bilgi') {
      const cariUnvani = (args as Record<string, any>).cari_unvani;
      const paraBirimi = (args as Record<string, any>).para_birimi;

      if (cariUnvani && cariUnvani.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;',
          `DECLARE @ArananCariUnvani NVARCHAR(255) = '${cariUnvani.replace(/'/g, "''")}';`
        );
      }

      if (paraBirimi && paraBirimi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananParaBirimi NVARCHAR(10) = NULL;',
          `DECLARE @ArananParaBirimi NVARCHAR(10) = '${paraBirimi.replace(/'/g, "''")}';`
        );
      }
    } else if (name === 'stok_raporu') {
      const urunAdi = (args as Record<string, any>).urun_adi;
      const depoAdi = (args as Record<string, any>).depo_adi;

      if (urunAdi && urunAdi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananUrunAdi NVARCHAR(255) = NULL;',
          `DECLARE @ArananUrunAdi NVARCHAR(255) = '${urunAdi.replace(/'/g, "''")}';`
        );
      }

      if (depoAdi && depoAdi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananDepoAdi NVARCHAR(50) = NULL;',
          `DECLARE @ArananDepoAdi NVARCHAR(50) = '${depoAdi.replace(/'/g, "''")}';`
        );
      }
    } else if (name === 'teklif_raporu') {
      const cariUnvani = (args as Record<string, any>).cari_unvani;
      const teklifDurumu = (args as Record<string, any>).teklif_durumu;
      const teklifAciklamasi = (args as Record<string, any>).teklif_aciklamasi;

      if (cariUnvani && cariUnvani.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;',
          `DECLARE @ArananCariUnvani NVARCHAR(255) = '${cariUnvani.replace(/'/g, "''")}';`
        );
      }

      if (teklifDurumu && teklifDurumu.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @TeklifDurumu NVARCHAR(50) = NULL;',
          `DECLARE @TeklifDurumu NVARCHAR(50) = '${teklifDurumu.replace(/'/g, "''")}';`
        );
      }

      if (teklifAciklamasi && teklifAciklamasi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @TeklifAciklamasi NVARCHAR(255) = NULL;',
          `DECLARE @TeklifAciklamasi NVARCHAR(255) = '${teklifAciklamasi.replace(/'/g, "''")}';`
        );
      }
    } else if (name === 'teklif_detay') {
      const teklifNo = (args as Record<string, any>).teklif_no;
      if (teklifNo && teklifNo.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @TeklifNo NVARCHAR(50) = NULL;',
          `DECLARE @TeklifNo NVARCHAR(50) = '${teklifNo.replace(/'/g, "''")}';`
        );
      }
    } else if (name === 'kredi_karti_limitleri') {
      const bankaAdi = (args as Record<string, any>).banka_adi;
      if (bankaAdi && bankaAdi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananBankaAdi NVARCHAR(100) = NULL;',
          `DECLARE @ArananBankaAdi NVARCHAR(100) = '${bankaAdi.replace(/'/g, "''")}';`
        );
      }
    } else if (name === 'doviz_hesaplari_tl_karsiligi') {
      const bankaAdi = (args as Record<string, any>).banka_adi;
      if (bankaAdi && bankaAdi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananBankaAdi NVARCHAR(100) = NULL;',
          `DECLARE @ArananBankaAdi NVARCHAR(100) = '${bankaAdi.replace(/'/g, "''")}';`
        );
      }
    } else if (name === 'cari_hareket') {
      const cariUnvani = (args as Record<string, any>).cari_unvani;
      const baslangicTarihi = (args as Record<string, any>).baslangic_tarihi;
      const bitisTarihi = (args as Record<string, any>).bitis_tarihi;

      if (cariUnvani && cariUnvani.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;',
          `DECLARE @ArananCariUnvani NVARCHAR(255) = '${cariUnvani.replace(/'/g, "''")}';`
        );
      }

      if (baslangicTarihi && baslangicTarihi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @BaslangicTarihi DATE = NULL;',
          `DECLARE @BaslangicTarihi DATE = '${baslangicTarihi}';`
        );
      }

      if (bitisTarihi && bitisTarihi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @BitisTarihi DATE = NULL;',
          `DECLARE @BitisTarihi DATE = '${bitisTarihi}';`
        );
      }
    } else if (name === 'bakiyeler_listesi') {
      const grupFiltresi = (args as Record<string, any>).grup_filtresi;
      const ticariUnvanFiltresi = (args as Record<string, any>).ticari_unvan_filtresi;
      const bakiyeDurumuFiltresi = (args as Record<string, any>).bakiye_durumu_filtresi;

      console.log('🔧 Bakiyeler listesi parametreleri:', { grupFiltresi, ticariUnvanFiltresi, bakiyeDurumuFiltresi });

      // Grup filtresi
      if (grupFiltresi && grupFiltresi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @GrupFiltresi NVARCHAR(100) = NULL;',
          `DECLARE @GrupFiltresi NVARCHAR(100) = '${grupFiltresi.replace(/'/g, "''")}';`
        );
        console.log('✅ Grup filtresi uygulandı:', grupFiltresi);
      }

      // Ticari ünvan filtresi
      if (ticariUnvanFiltresi && ticariUnvanFiltresi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @TicariUnvanFiltresi NVARCHAR(255) = NULL;',
          `DECLARE @TicariUnvanFiltresi NVARCHAR(255) = '${ticariUnvanFiltresi.replace(/'/g, "''")}';`
        );
        console.log('✅ Ticari ünvan filtresi uygulandı:', ticariUnvanFiltresi);
      }

      // Bakiye durumu filtresi
      if (bakiyeDurumuFiltresi && bakiyeDurumuFiltresi.trim() !== '') {
        finalQuery = finalQuery.replace(
          'DECLARE @BakiyeDurumuFiltresi NVARCHAR(20) = NULL;',
          `DECLARE @BakiyeDurumuFiltresi NVARCHAR(20) = '${bakiyeDurumuFiltresi.replace(/'/g, "''")}';`
        );
        console.log('✅ Bakiye durumu filtresi uygulandı:', bakiyeDurumuFiltresi);
      }

      // Debug: Final query'nin bir kısmını logla
      const queryStart = finalQuery.substring(0, 500);
      console.log('🔍 Final query başlangıcı:', queryStart);
    } else {
      // Diğer sorgular için normal parametre işleme
      for (const param of queryDef.parameters) {
        const value = (args as Record<string, any>)[param.name];
        if (value !== undefined && value !== null) {
          request.input(param.name, value);
        } else if (param.required) {
          throw new McpError(ErrorCode.InvalidParams, `Gerekli parametre eksik: ${param.name}`);
        }
      }
    }

    const result = await request.query(finalQuery);

    // Verileri JSON-safe hale getir
    const cleanData = result.recordset.map(row => {
      const cleanRow: any = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined) {
          cleanRow[key] = null;
        } else if (typeof value === 'string') {
          // Türkçe karakterleri ve özel karakterleri temizle
          cleanRow[key] = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
        } else if (typeof value === 'number') {
          // NaN ve Infinity kontrolü
          cleanRow[key] = isFinite(value) ? value : null;
        } else if (value instanceof Date) {
          cleanRow[key] = value.toISOString();
        } else {
          cleanRow[key] = String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
        }
      }
      return cleanRow;
    });

    // Günlük kayıt
    console.error(`Sorgu çalıştırıldı - Kullanıcı: ${user.name}, Sorgu: ${name}, Zaman: ${new Date().toISOString()}`);

    // Güvenli JSON oluştur
    const responseData = {
      success: true,
      query: name,
      recordCount: cleanData.length,
      data: cleanData,
      executedAt: new Date().toISOString(),
      user: user.name
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(responseData, (_key, value) => {
            // JSON.stringify için güvenli replacer
            if (typeof value === 'string') {
              return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
            }
            return value;
          }, 2)
        }
      ]
    };

  } catch (error) {
    console.error(`Sorgu hatası - ${name}:`, error);

    // Hata mesajını temizle
    let errorMessage = "Bilinmeyen hata";
    if (error instanceof Error) {
      errorMessage = error.message.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
    }

    const errorData = {
      success: false,
      error: errorMessage,
      query: name,
      executedAt: new Date().toISOString()
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(errorData, (_key, value) => {
            if (typeof value === 'string') {
              return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
            }
            return value;
          }, 2)
        }
      ]
    };
  }
});

// Sorgu çalıştırma fonksiyonu (HTTP API için)
async function executeQuery(queryName: string, parameters: any = {}) {
  const queryDef = predefinedQueries[queryName];
  if (!queryDef) {
    throw new Error(`Bilinmeyen sorgu: ${queryName}`);
  }

  const request = pool!.request();
  let finalQuery = queryDef.query;

  // Parametre işleme
  if (queryName === 'banka_bakiyeleri') {
    const bankaAdi = parameters.banka_adi;
    const paraBirimi = parameters.para_birimi;

    if (bankaAdi && bankaAdi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananBankaAdiParam NVARCHAR(100) = NULL;',
        `DECLARE @ArananBankaAdiParam NVARCHAR(100) = '${bankaAdi.replace(/'/g, "''")}';`
      );
    }

    if (paraBirimi && paraBirimi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananParaBirimi NVARCHAR(10) = NULL;',
        `DECLARE @ArananParaBirimi NVARCHAR(10) = '${paraBirimi.replace(/'/g, "''")}';`
      );
    }
  } else if (queryName === 'cari_bilgi') {
    const cariUnvani = parameters.cari_unvani;
    const paraBirimi = parameters.para_birimi;

    if (cariUnvani && cariUnvani.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;',
        `DECLARE @ArananCariUnvani NVARCHAR(255) = '${cariUnvani.replace(/'/g, "''")}';`
      );
    }

    if (paraBirimi && paraBirimi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananParaBirimi NVARCHAR(10) = NULL;',
        `DECLARE @ArananParaBirimi NVARCHAR(10) = '${paraBirimi.replace(/'/g, "''")}';`
      );
    }
  } else if (queryName === 'stok_raporu') {
    const urunAdi = parameters.urun_adi;
    const depoAdi = parameters.depo_adi;

    if (urunAdi && urunAdi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananUrunAdi NVARCHAR(255) = NULL;',
        `DECLARE @ArananUrunAdi NVARCHAR(255) = '${urunAdi.replace(/'/g, "''")}';`
      );
    }

    if (depoAdi && depoAdi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananDepoAdi NVARCHAR(50) = NULL;',
        `DECLARE @ArananDepoAdi NVARCHAR(50) = '${depoAdi.replace(/'/g, "''")}';`
      );
    }
  } else if (queryName === 'kredi_karti_limitleri') {
    const bankaAdi = parameters.banka_adi;
    if (bankaAdi && bankaAdi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananBankaAdi NVARCHAR(100) = NULL;',
        `DECLARE @ArananBankaAdi NVARCHAR(100) = '${bankaAdi.replace(/'/g, "''")}';`
      );
    }
  } else if (queryName === 'doviz_hesaplari_tl_karsiligi') {
    const bankaAdi = parameters.banka_adi;
    if (bankaAdi && bankaAdi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananBankaAdi NVARCHAR(100) = NULL;',
        `DECLARE @ArananBankaAdi NVARCHAR(100) = '${bankaAdi.replace(/'/g, "''")}';`
      );
    }
  } else if (queryName === 'teklif_raporu') {
    const cariUnvani = parameters.cari_unvani;
    const teklifDurumu = parameters.teklif_durumu;
    const teklifAciklamasi = parameters.teklif_aciklamasi;

    if (cariUnvani && cariUnvani.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;',
        `DECLARE @ArananCariUnvani NVARCHAR(255) = '${cariUnvani.replace(/'/g, "''")}';`
      );
    }

    if (teklifDurumu && teklifDurumu.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @TeklifDurumu NVARCHAR(50) = NULL;',
        `DECLARE @TeklifDurumu NVARCHAR(50) = '${teklifDurumu.replace(/'/g, "''")}';`
      );
    }

    if (teklifAciklamasi && teklifAciklamasi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @TeklifAciklamasi NVARCHAR(255) = NULL;',
        `DECLARE @TeklifAciklamasi NVARCHAR(255) = '${teklifAciklamasi.replace(/'/g, "''")}';`
      );
    }
  } else if (queryName === 'teklif_detay') {
    const teklifNo = parameters.teklif_no;
    if (teklifNo && teklifNo.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @TeklifNo NVARCHAR(50) = NULL;',
        `DECLARE @TeklifNo NVARCHAR(50) = '${teklifNo.replace(/'/g, "''")}';`
      );
    }
  } else if (queryName === 'cari_hareket') {
    const cariUnvani = parameters.cari_unvani;
    const baslangicTarihi = parameters.baslangic_tarihi;
    const bitisTarihi = parameters.bitis_tarihi;

    if (cariUnvani && cariUnvani.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @ArananCariUnvani NVARCHAR(255) = NULL;',
        `DECLARE @ArananCariUnvani NVARCHAR(255) = '${cariUnvani.replace(/'/g, "''")}';`
      );
    }

    if (baslangicTarihi && baslangicTarihi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @BaslangicTarihi DATE = NULL;',
        `DECLARE @BaslangicTarihi DATE = '${baslangicTarihi}';`
      );
    }

    if (bitisTarihi && bitisTarihi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @BitisTarihi DATE = NULL;',
        `DECLARE @BitisTarihi DATE = '${bitisTarihi}';`
      );
    }
  } else if (queryName === 'bakiyeler_listesi') {
    // HTTP API için bakiyeler_listesi parametre işleme
    const grupFiltresi = parameters.grup_filtresi;
    const ticariUnvanFiltresi = parameters.ticari_unvan_filtresi;
    const bakiyeDurumuFiltresi = parameters.bakiye_durumu_filtresi;

    console.log('🔧 HTTP API - Bakiyeler listesi parametreleri:', { grupFiltresi, ticariUnvanFiltresi, bakiyeDurumuFiltresi });

    // Grup filtresi
    if (grupFiltresi && grupFiltresi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @GrupFiltresi NVARCHAR(100) = NULL;',
        `DECLARE @GrupFiltresi NVARCHAR(100) = '${grupFiltresi.replace(/'/g, "''")}';`
      );
      console.log('✅ HTTP API - Grup filtresi uygulandı:', grupFiltresi);
    }

    // Ticari ünvan filtresi
    if (ticariUnvanFiltresi && ticariUnvanFiltresi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @TicariUnvanFiltresi NVARCHAR(255) = NULL;',
        `DECLARE @TicariUnvanFiltresi NVARCHAR(255) = '${ticariUnvanFiltresi.replace(/'/g, "''")}';`
      );
      console.log('✅ HTTP API - Ticari ünvan filtresi uygulandı:', ticariUnvanFiltresi);
    }

    // Bakiye durumu filtresi
    if (bakiyeDurumuFiltresi && bakiyeDurumuFiltresi.trim() !== '') {
      finalQuery = finalQuery.replace(
        'DECLARE @BakiyeDurumuFiltresi NVARCHAR(20) = NULL;',
        `DECLARE @BakiyeDurumuFiltresi NVARCHAR(20) = '${bakiyeDurumuFiltresi.replace(/'/g, "''")}';`
      );
      console.log('✅ HTTP API - Bakiye durumu filtresi uygulandı:', bakiyeDurumuFiltresi);
    }

    // Debug: Final query'nin bir kısmını logla
    const queryStart = finalQuery.substring(0, 500);
    console.log('🔍 HTTP API - Final query başlangıcı:', queryStart);
  } else {
    for (const param of queryDef.parameters) {
      const value = parameters[param.name];
      if (value !== undefined && value !== null) {
        request.input(param.name, value);
      } else if (param.required) {
        throw new Error(`Gerekli parametre eksik: ${param.name}`);
      }
    }
  }

  const result = await request.query(finalQuery);

  // Verileri temizle
  const cleanData = result.recordset.map(row => {
    const cleanRow: any = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) {
        cleanRow[key] = null;
      } else if (typeof value === 'string') {
        cleanRow[key] = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
      } else if (typeof value === 'number') {
        cleanRow[key] = isFinite(value) ? value : null;
      } else if (value instanceof Date) {
        cleanRow[key] = value.toISOString();
      } else {
        cleanRow[key] = String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
      }
    }
    return cleanRow;
  });

  return {
    recordCount: cleanData.length,
    data: cleanData
  };
}

// HTTP API Sunucusu
async function startHttpServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Test paneli (ana panel)
  app.use('/test', express.static('./', {
    index: 'api-test.html'
  }));

  // Ana sayfa için redirect (test paneline)
  app.get('/', (req: any, res: any) => {
    res.redirect(301, '/test/');
  });

  // API Key kontrolü
  const authenticateApiKey = (req: any, res: any, next: any) => {
    const apiKey = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');

    console.log('🔑 API Key kontrolü:', {
      receivedKey: apiKey,
      expectedKey: process.env.WOLVOKS_API_KEY,
      headers: req.headers
    });

    if (!apiKey || apiKey !== process.env.WOLVOKS_API_KEY) {
      return res.status(401).json({ error: 'Geçersiz API key' });
    }
    next();
  };

  // Query endpoint
  app.post('/query', authenticateApiKey, async (req, res) => {
    try {
      const { query, parameters = {} } = req.body;

      console.log(`📡 HTTP API: ${query} sorgusu alındı`, parameters);

      if (!predefinedQueries[query]) {
        return res.status(400).json({
          success: false,
          error: `Bilinmeyen sorgu: ${query}`
        });
      }

      const result = await executeQuery(query, parameters);

      console.log(`✅ HTTP API: ${query} sorgusu tamamlandı, ${result.recordCount} kayıt`);

      res.json({
        success: true,
        query: query,
        recordCount: result.recordCount,
        data: result.data,
        executedAt: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ HTTP API Hatası:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Bilinmeyen hata'
      });
    }
  });

  // Health check endpoint (authentication gerektirmez)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      queries: Object.keys(predefinedQueries),
      message: 'TARS ERP API Server is running'
    });
  });

  // Authentication test endpoint
  app.post('/auth/test', (req: any, res: any) => {
    const apiKey = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');

    console.log('🔐 Auth test:', {
      receivedKey: apiKey,
      expectedKey: process.env.WOLVOKS_API_KEY
    });

    if (!apiKey || apiKey !== process.env.WOLVOKS_API_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Geçersiz API key'
      });
    }

    res.json({
      success: true,
      message: 'API key geçerli',
      timestamp: new Date().toISOString()
    });
  });

  // Status endpoint (detaylı sistem bilgisi)
  app.get('/status', authenticateApiKey, async (_req, res) => {
    try {
      const dbStatus = pool ? 'connected' : 'disconnected';
      const uptime = process.uptime();

      res.json({
        server: {
          name: 'TAR-S ERP ZEK MCP Server',
          version: '1.0.0',
          status: 'running',
          uptime: `${Math.floor(uptime / 60)} dakika ${Math.floor(uptime % 60)} saniye`,
          timestamp: new Date().toISOString()
        },
        database: {
          status: dbStatus,
          server: process.env.MSSQL_SERVER,
          database: process.env.MSSQL_DATABASE,
          poolConnected: pool?.connected || false
        },
        queries: {
          total: Object.keys(predefinedQueries).length,
          available: Object.keys(predefinedQueries)
        },
        users: {
          total: users.length,
          registered: users.map(u => ({ name: u.name, rateLimit: u.rateLimit }))
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Status bilgisi alınamadı'
      });
    }
  });

  const PORT = process.env.HTTP_PORT || 3000;

  // Ağ IP adreslerini al
  const os = await import('os');
  const networkInterfaces = os.networkInterfaces();
  const ipAddresses: string[] = [];

  Object.keys(networkInterfaces).forEach(interfaceName => {
    const interfaces = networkInterfaces[interfaceName];
    if (interfaces) {
      interfaces.forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
          ipAddresses.push(iface.address);
        }
      });
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP API Sunucusu başlatıldı:`);
    console.log(`   📍 Localhost: http://localhost:${PORT}`);
    console.log(`   📍 Localhost: http://127.0.0.1:${PORT}`);

    if (ipAddresses.length > 0) {
      console.log(`   🌍 Ağ Adresleri:`);
      ipAddresses.forEach(ip => {
        console.log(`      • http://${ip}:${PORT}`);
        console.log(`      • http://${ip}:${PORT}/test (Test Panel)`);
      });
    } else {
      console.log(`   ⚠️  Ağ adresi bulunamadı`);
    }

    console.log(`📡 API Endpoints:`);
    console.log(`   • POST /query - Sorgu çalıştırma`);
    console.log(`   • POST /auth/test - API key test`);
    console.log(`   • GET /health - Sistem durumu`);
    console.log(`🔑 API Key: ${process.env.WOLVOKS_API_KEY}`);
  });
}

// Sunucuyu başlat
async function main() {
  try {
    console.error("Wolvoks ERP MCP Sunucusu başlatılıyor...");

    await initializeDatabase();
    console.error("✅ Veritabanı bağlantısı başarılı");

    // HTTP API Sunucusunu başlat
    await startHttpServer();

    // MCP Sunucusunu başlat (stdio transport)
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("✅ Wolvoks ERP MCP Sunucusu başlatıldı");
    console.error("📊 Mevcut sorgular:", Object.keys(predefinedQueries));
    console.error("👥 Kayıtlı kullanıcılar:", users.map(u => u.name));
    console.error("🚀 Sunucu hazır ve istekleri bekliyor...");

  } catch (error) {
    console.error("❌ Sunucu başlatma hatası:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('Sunucu kapatılıyor...');
  if (pool) {
    await pool.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Sunucu sonlandırılıyor...');
  if (pool) {
    await pool.close();
  }
  process.exit(0);
});

main().catch(console.error);