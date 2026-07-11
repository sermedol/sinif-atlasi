// Sınıf Atlası — kendi CORS proxy'niz (Cloudflare Worker)
//
// Ne işe yarar: Sınıf Atlası tarayıcıdan doğrudan erişilemeyen (CORS engelli)
// haber kaynaklarına (Google Haberler RSS, haber sitesi sayfaları) bu worker
// üzerinden ulaşır. Ücretsiz paylaşılan proxy'lerin aksine bu SADECE sizin
// kotanızı kullanır, başkalarının kötüye kullanımından etkilenmez.
//
// Kurulum:
// 1. https://dash.cloudflare.com adresine gidip ücretsiz bir hesap açın
//    (zaten hesabınız varsa giriş yapın).
// 2. Sol menüden "Workers & Pages" > "Create" > "Create Worker" seçin.
// 3. Worker'a bir isim verin (örn. "sinif-atlasi-proxy") ve "Deploy" deyin.
// 4. Oluşan worker'ı açın, "Edit code" / kod düzenleyiciye girin.
// 5. Editördeki mevcut örnek kodun TAMAMINI silip bu dosyanın içeriğini yapıştırın.
// 6. Sağ üstten "Deploy" / "Save and deploy" deyin.
// 7. Worker'ınızın adresi şuna benzer olacak:
//    https://sinif-atlasi-proxy.KULLANICI-ADINIZ.workers.dev
//    Bu tam adresi Claude'a (bana) verin, kodun geri kalanına ben ekleyeceğim.

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    // Tarayıcının "preflight" (OPTIONS) isteğine izin ver.
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Umut-Sen'in kendi Facebook Sayfası / Instagram İşletme hesabından
    // paylaşımları çeker. Token/App Secret asla tarayıcıya çıkmaz — sadece
    // bu worker içinde, Cloudflare'ın şifreli "Secret" ortam değişkenlerinden
    // okunur (Settings > Variables and Secrets).
    if (requestUrl.searchParams.has("social")) {
      return handleSocial(requestUrl, env);
    }

    // "Konum" sütunundaki açık adresleri OpenStreetMap'in ücretsiz Nominatim
    // servisiyle koordinata çevirir. Sonuç Cloudflare'ın kenar (edge)
    // önbelleğinde uzun süre tutulur — aynı adres binlerce ziyaretçi
    // tarafından açılsa bile Nominatim'e sadece BİR kez istek gider
    // (kullanım politikasına saygılı kalmak için).
    if (requestUrl.searchParams.has("geocode")) {
      return handleGeocode(requestUrl);
    }

    // Google'ın kısa paylaşım linkleri (maps.app.goo.gl/... gibi) adres
    // içermez — gerçek konumu görmek için yönlendirmeyi (redirect) takip
    // etmek gerekir. Tarayıcı bunu CORS yüzünden okuyamaz; bu worker
    // sunucu tarafında yönlendirmeyi takip edip son URL'deki koordinatı
    // (…/@lat,lng,… veya …!3dlat!4dlng…) çıkarır.
    if (requestUrl.searchParams.has("resolve")) {
      return handleResolveLink(requestUrl);
    }

    const target = requestUrl.searchParams.get("url");
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response("Eksik veya geçersiz 'url' parametresi.", {
        status: 400,
        headers: corsHeaders()
      });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "*/*"
        },
        redirect: "follow",
        cf: { cacheTtl: 120, cacheEverything: false }
      });

      const contentType = upstream.headers.get("Content-Type") || "text/plain; charset=utf-8";
      const body = await upstream.arrayBuffer();

      return new Response(body, {
        status: upstream.status,
        headers: { ...corsHeaders(), "Content-Type": contentType }
      });
    } catch (error) {
      return new Response("Proxy hatası: " + error.message, {
        status: 502,
        headers: corsHeaders()
      });
    }
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "public, max-age=120"
  };
}

// Doğru ve KALICI Sayfa jetonu akışı:
// 1. Kısa ömürlü bir KULLANICI jetonu (FB_USER_TOKEN), App ID/Secret ile
//    uzun ömürlü (~60 gün) bir Kullanıcı jetonuna çevrilir.
// 2. O uzun ömürlü Kullanıcı jetonuyla Sayfa'nın KENDİ jetonu istenir
//    (/{page-id}?fields=access_token). Bu şekilde alınan Sayfa jetonu,
//    kullanıcı Sayfa yöneticisi kaldığı sürece SÜRESİZ geçerli olur.
// Worker'ın çalıştığı süre boyunca bellekte tutulur; her istekte bu iki
// adım tekrarlanmaz.
const pageTokenCache = {};

async function getPageAccessToken(env, pageId) {
  const now = Date.now();
  const cached = pageTokenCache[pageId];
  if (cached && now < cached.expiry) return cached.token;
  if (!env.FB_APP_ID || !env.FB_APP_SECRET || !env.FB_USER_TOKEN) return null;

  try {
    const exchangeUrl = `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?grant_type=fb_exchange_token&client_id=${encodeURIComponent(env.FB_APP_ID)}` +
      `&client_secret=${encodeURIComponent(env.FB_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(env.FB_USER_TOKEN)}`;
    const exchangeResponse = await fetch(exchangeUrl);
    const exchangeData = await exchangeResponse.json();
    const longLivedUserToken = exchangeData.access_token || env.FB_USER_TOKEN;

    const pageUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}` +
      `?fields=access_token&access_token=${encodeURIComponent(longLivedUserToken)}`;
    const pageResponse = await fetch(pageUrl);
    const pageData = await pageResponse.json();
    if (pageData.access_token) {
      pageTokenCache[pageId] = { token: pageData.access_token, expiry: now + 24 * 60 * 60 * 1000 };
      return pageTokenCache[pageId].token;
    }
  } catch {}
  return null;
}

// Geçici teşhis ucu — token'ın kendisini asla açığa çıkarmaz, sadece
// değişim (exchange) adımının nerede başarısız olduğunu gösterir.
async function handleDebug(env) {
  const info = {
    hasAppId: Boolean(env.FB_APP_ID),
    hasAppSecret: Boolean(env.FB_APP_SECRET),
    hasUserToken: Boolean(env.FB_USER_TOKEN)
  };
  if (!info.hasAppId || !info.hasAppSecret || !info.hasUserToken) {
    return new Response(JSON.stringify({ ...info, step: "eksik secret var" }, null, 2), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
  try {
    const exchangeUrl = `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?grant_type=fb_exchange_token&client_id=${encodeURIComponent(env.FB_APP_ID)}` +
      `&client_secret=${encodeURIComponent(env.FB_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(env.FB_USER_TOKEN)}`;
    const exchangeResponse = await fetch(exchangeUrl);
    const exchangeData = await exchangeResponse.json();
    info.exchangeSucceeded = Boolean(exchangeData.access_token);
    info.exchangeExpiresIn = exchangeData.expires_in || null;
    info.exchangeError = exchangeData.error || null;
    return new Response(JSON.stringify(info, null, 2), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  } catch (error) {
    info.exchangeThrew = error.message;
    return new Response(JSON.stringify(info, null, 2), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
}

async function handleSocial(requestUrl, env) {
  const kind = requestUrl.searchParams.get("social");
  if (kind === "debug") return handleDebug(env);
  const pageId = requestUrl.searchParams.get("pageId") || requestUrl.searchParams.get("igId");
  const token = pageId ? await getPageAccessToken(env, pageId) : null;
  if (!token) {
    return new Response(JSON.stringify({ error: "Token yapılandırılmamış veya alınamadı." }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }

  let apiUrl;
  if (kind === "facebook") {
    const pageId = requestUrl.searchParams.get("pageId");
    if (!pageId) return new Response("pageId eksik.", { status: 400, headers: corsHeaders() });
    apiUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/posts` +
      `?fields=message,full_picture,permalink_url,created_time&limit=25&access_token=${encodeURIComponent(token)}`;
  } else if (kind === "instagram") {
    const igId = requestUrl.searchParams.get("igId");
    if (!igId) return new Response("igId eksik.", { status: 400, headers: corsHeaders() });
    apiUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(igId)}/media` +
      `?fields=caption,media_url,thumbnail_url,permalink,timestamp,media_type&limit=25&access_token=${encodeURIComponent(token)}`;
  } else {
    return new Response("Bilinmeyen 'social' parametresi (facebook/instagram olmalı).", {
      status: 400,
      headers: corsHeaders()
    });
  }

  try {
    const upstream = await fetch(apiUrl, { cf: { cacheTtl: 300, cacheEverything: false } });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Sosyal medya isteği başarısız: " + error.message }), {
      status: 502,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
}

async function handleGeocode(requestUrl) {
  const address = requestUrl.searchParams.get("geocode");
  if (!address || address.trim().length < 4) {
    return new Response(JSON.stringify({ error: "Geçersiz adres." }), {
      status: 400,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
  const nominatimUrl = `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(address)}&format=jsonv2&limit=1&countrycodes=tr`;
  try {
    const upstream = await fetch(nominatimUrl, {
      headers: {
        // Nominatim kullanım politikası, tanımlayıcı bir User-Agent zorunlu kılar.
        "User-Agent": "DirenisHaritasi/1.0 (https://direnis-haritasi.umutsen.org)"
      },
      // 30 gün: adresler değişmediği için Cloudflare kenarında uzun süre
      // önbelleğe alınır, Nominatim'e tekrar tekrar gidilmez.
      cf: { cacheTtl: 2592000, cacheEverything: true }
    });
    const data = await upstream.json();
    const first = Array.isArray(data) ? data[0] : null;
    const result = first ? { lat: Number(first.lat), lng: Number(first.lon) } : null;
    return new Response(JSON.stringify({ result }), {
      headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "public, max-age=2592000" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Geocode isteği başarısız: " + error.message }), {
      status: 502,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
}

async function handleResolveLink(requestUrl) {
  const link = requestUrl.searchParams.get("resolve");
  if (!link || !/^https?:\/\//i.test(link)) {
    return new Response(JSON.stringify({ error: "Geçersiz link." }), {
      status: 400,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
  try {
    const upstream = await fetch(link, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
      },
      // Kısa linkin hedefi neredeyse hiç değişmez — Cloudflare kenarında
      // uzun süre önbelleğe alınır, aynı linke tekrar istek gitmez.
      cf: { cacheTtl: 2592000, cacheEverything: true }
    });
    const finalUrl = upstream.url;
    let lat = null;
    let lng = null;
    // "!3dENLEM!4dBOYLAM" işaretçinin kendi tam koordinatı, "@enlem,boylam"
    // ise görünüm merkezi — ikisi de varsa işaretçininkini tercih et.
    const pinMatch = finalUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const centerMatch = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (pinMatch) {
      lat = Number(pinMatch[1]);
      lng = Number(pinMatch[2]);
    } else if (centerMatch) {
      lat = Number(centerMatch[1]);
      lng = Number(centerMatch[2]);
    }
    let label = null;
    const placeMatch = finalUrl.match(/\/maps\/place\/([^/@]+)/);
    if (placeMatch) {
      try { label = decodeURIComponent(placeMatch[1].replace(/\+/g, " ")); } catch (e) {}
    }
    const result = (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng, label } : null;
    return new Response(JSON.stringify({ result }), {
      headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "public, max-age=2592000" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Link çözümlenemedi: " + error.message }), {
      status: 502,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
}
