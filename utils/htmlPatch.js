'use strict';
/**
 * htmlPatch.js — Aplica cambios del admin de forma quirúrgica al HTML guardado.
 * Solo toca los datos (colores, precios, visibilidad de productos).
 * Nunca modifica la estructura del diseño del editor.
 */
const cheerio = require('cheerio');
const { getProductBySlug, getAllProducts, getAllCategories, getSettings } = require('../db/sqlite');

const fmt = p => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(p || 0);

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* Genera los botones de color para la página de producto (omite los desactivados) */
function buildColorButtons(colors, variants) {
  if (!colors || !colors.length) return '';
  const activeColors = colors.filter(c => c.enabled !== false);
  if (!activeColors.length) return '';
  return activeColors.map((c, i) => {
    const swatchSrc = esc(c.swatch_url || c.image_url || '');
    const cName     = esc(c.name || '');
    const cImg      = esc(c.image_url || c.swatch_url || '');
    const cFit      = esc(c.img_fit || 'contain');
    const cPos      = esc(c.img_pos || 'center');
    const cScale    = c.detail_img_scale || c.img_scale || 1;
    const caps      = encodeURIComponent(JSON.stringify(
      Array.isArray(c.available_caps) && c.available_caps.length
        ? c.available_caps
        : (variants || []).map(v => v.label)
    ));
    const gallery   = encodeURIComponent(JSON.stringify(c.gallery || []));
    const imgHtml   = swatchSrc
      ? `<img src="${swatchSrc}" alt="${cName}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;display:block" onerror="this.style.display='none'">`
      : `<span style="width:48px;height:48px;border-radius:50%;background:#e8e8ed;display:block"></span>`;
    return `<button onclick="selectColor(this,this.dataset.img,this.dataset.name,this.dataset.fit,this.dataset.pos,this.dataset.scale,JSON.parse(decodeURIComponent(this.dataset.caps||'%5B%5D')),JSON.parse(decodeURIComponent(this.dataset.gallery||'%5B%5D')))" data-img="${cImg}" data-name="${cName}" data-fit="${cFit}" data-pos="${cPos}" data-scale="${cScale}" data-caps="${caps}" data-gallery="${gallery}" title="${cName}" class="color-swatch${i===0?' active':''}" style="width:48px;height:48px;border-radius:50%;border:none;padding:0;cursor:pointer;background:transparent;transition:transform .2s,box-shadow .2s;box-shadow:${i===0?'0 0 0 3px rgba(0,113,227,.22)':'0 0 0 1px rgba(0,0,0,.08)'};position:relative;flex-shrink:0" onmouseover="if(!this.classList.contains('active')){this.style.boxShadow='0 0 0 1px rgba(0,0,0,.18)';this.style.transform='scale(1.08)'}" onmouseout="if(!this.classList.contains('active')){this.style.boxShadow='0 0 0 1px rgba(0,0,0,.08)';this.style.transform='scale(1)'}">${imgHtml}</button>`;
  }).join('');
}

/* Genera los botones de variante de almacenamiento para la página de producto */
function buildVariantButtons(variants, initialCaps) {
  if (!variants || !variants.length) return '';
  const caps = Array.isArray(initialCaps) ? initialCaps : [];
  const vFirst = variants.find(v => caps.length === 0 || caps.includes(v.label));
  return variants.map(v => {
    const vAvail  = caps.length === 0 || caps.includes(v.label);
    const vIsFirst = vFirst && v.label === vFirst.label;
    const priceHtml = v.price ? `<span style="font-size:11px;opacity:.7">${fmt(v.price)}</span>` : '';
    return `<button onclick="selectVariant(this,'${esc(v.label)}',${v.price||0})" class="variant-btn${vIsFirst?' variant-active':''}" ${!vAvail?'disabled':''} style="padding:10px 20px;border-radius:12px;border:${vIsFirst?'2px solid #1d1d1f':'1.5px solid #d2d2d7'};background:${vIsFirst?'#1d1d1f':'#fff'};color:${vIsFirst?'#fff':'#1d1d1f'};font-size:14px;font-weight:600;cursor:${vAvail?'pointer':'default'};transition:all .2s;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:80px;opacity:${vAvail?'1':'0.35'};text-decoration:${vAvail?'none':'line-through'}"><span>${esc(v.label)}</span>${priceHtml}</button>`;
  }).join('');
}

/* Genera las miniaturas de color en tarjeta de catálogo/categoría/home */
function buildCardSwatchesHtml(colorVariants, product) {
  const enabled = (colorVariants || []).filter(c => c && c.enabled !== false);
  if (!enabled.length) return '';
  const spans = enabled.slice(0, 4).map((c, ci) => {
    const sw = esc(c.swatch_url || c.image_url || '');
    const bg = sw ? `background-image:url('${sw}')` : 'background:#e8e8ed';
    return `<span class="ms-card-swatch${ci===0?' active':''}" style="width:18px;height:18px;${bg}" title="${esc(c.name||'')}" data-img="${esc(c.image_url||'')}" data-scale="${c.img_scale||product?.img_scale||1}" data-fit="${esc(c.img_fit||product?.img_fit||'contain')}" data-pos="${esc(c.img_pos||product?.img_pos||'center')}" onclick="cardSwatchClick(this,event)"></span>`;
  }).join('');
  const more = enabled.length > 4 ? `<span class="ms-card-swatch-more" style="width:18px;height:18px;font-size:9px">+${enabled.length-4}</span>` : '';
  return spans + more;
}

/* ── Parche principal ────────────────────────────────────────────────────── */
function patchSavedHtml(pageName, savedHtml) {
  if (!savedHtml) return savedHtml;
  try {
    const $ = cheerio.load(savedHtml, { decodeEntities: false });

    /* ── CSS Global (aplica a todas las páginas) ── */
    const globalCss = getSettings().global_css || '';
    const $existingGlobal = $('style#ms-global-css');
    if (globalCss) {
      const styleTag = `<style id="ms-global-css">${globalCss}</style>`;
      if ($existingGlobal.length) $existingGlobal.replaceWith(styleTag);
      else $('head').append(styleTag);
    } else if ($existingGlobal.length) {
      $existingGlobal.remove();
    }

    /* ── Nav de categorías: SOLO quitar las desactivadas, preservar el diseño del editor ── */
    const inactiveSlugs = new Set(
      getAllCategories().filter(c => !c.active).map(c => c.slug)
    );
    [$('nav.nav-links'), $('#mobNav')].forEach($nav => {
      if (!$nav.length) return;
      $nav.find('a[href^="/categoria/"]').each((_i, el) => {
        const slug = ($(el).attr('href') || '').replace('/categoria/', '').replace(/[/?#].*/, '');
        if (inactiveSlugs.has(slug)) $(el).remove();
      });
    });

    /* ── Tamaño del logo sincronizado (inline style del editor) ── */
    const globalLogoStyle = getSettings().global_logo_style || '';
    if (globalLogoStyle) {
      const $logoImg = $('a.nav-logo img, .nav-logo img').first();
      if ($logoImg.length) $logoImg.attr('style', globalLogoStyle);
    }

    /* ── Página de producto ── */
    if (pageName.startsWith('product-')) {
      const slug    = pageName.slice(8);
      const product = getProductBySlug(slug);
      if (!product || !product.active) return savedHtml;

      const colors = (product.color_variants || []).filter(c => c);
      const activeColors = colors.filter(c => c.enabled !== false);
      const initialColor = activeColors[0] || null;

      // Parchar imagen principal para que use el primer color activo (evita el "fantasma")
      if (initialColor) {
        const mSrc  = initialColor.image_url || product.image_url || '';
        const isVid = /\.(mp4|webm|ogg|mov)$/i.test(mSrc);
        const scale = initialColor.detail_img_scale || initialColor.img_scale || product.detail_img_scale || product.img_scale || 1;
        const fit   = initialColor.img_fit || product.img_fit || 'contain';
        const pos   = initialColor.img_pos || product.img_pos || 'center';

        const $mainImg = $('#mainImg');
        if ($mainImg.length) {
          $mainImg.attr('src', mSrc);
          $mainImg.attr('style', `display:${isVid?'none':'block'};width:100%;height:100%;object-fit:${fit};object-position:${pos};transform:scale(${scale});transform-origin:center center;transition:transform 0.4s ease, opacity 0.4s ease`);
        }
        const $mainVid = $('#mainVid');
        if ($mainVid.length) {
          $mainVid.attr('src', mSrc);
          $mainVid.attr('style', `display:${isVid?'block':'none'};width:100%;height:100%;object-fit:contain;transform:scale(${scale});transform-origin:center center;transition:transform 0.4s ease, opacity 0.4s ease`);
        }

        // Parchar galería de miniaturas
        const $galCont = $('#galleryContainer');
        if ($galCont.length) {
          const gArr = [initialColor.image_url, ...(initialColor.gallery || [])].filter(Boolean);
          if (gArr.length > 1) {
            $galCont.attr('style', `display:flex;gap:16px;margin-top:24px;justify-content:center;overflow-x:auto`);
            $galCont.html(gArr.map((gUrl, idx) =>
              `<button onclick="changeColor('${esc(gUrl)}',window._selectedColor||'','${esc(fit)}','${esc(pos)}',${scale});document.querySelectorAll('.gal-thumb').forEach(b=>b.style.borderColor='transparent');this.style.borderColor='#0071e3'" class="gal-thumb" style="width:64px;height:64px;border-radius:12px;border:2px solid ${idx===0?'#0071e3':'transparent'};background:#f5f5f7;padding:4px;cursor:pointer;flex-shrink:0;transition:border-color .2s"><img src="${esc(gUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px" onerror="this.style.display='none'"></button>`
            ).join(''));
          } else {
            $galCont.attr('style', 'display:none;gap:16px;margin-top:24px;justify-content:center;overflow-x:auto');
            $galCont.empty();
          }
        }
      }

      // Parchar botones de colores sin tocar el contenedor (preserva posición/tamaño del editor)
      const $colorLabel = $('p#colorLabel');
      if ($colorLabel.length && colors.length) {
        const initialName = initialColor?.name || '';
        $colorLabel.text(initialName);
        const $btnsDiv = $colorLabel.next('div');
        if ($btnsDiv.length) {
          $btnsDiv.html(buildColorButtons(colors, product.variants || []));
        }
      }

      // Parchar variantes de almacenamiento
      const variants = product.variants || [];
      const $firstVariantBtn = $('.variant-btn').first();
      if ($firstVariantBtn.length) {
        const initialCaps = initialColor && Array.isArray(initialColor.available_caps) && initialColor.available_caps.length
          ? initialColor.available_caps
          : variants.map(v => v.label);
        if (variants.length) {
          $firstVariantBtn.parent().html(buildVariantButtons(variants, initialCaps));
        } else {
          // Sin variantes: quitar toda la sección (el div padre con "Almacenamiento")
          $firstVariantBtn.parent().parent().remove();
        }
      }

      // Parchar precio actual
      const $price = $('#mainPrice');
      if ($price.length) $price.text(fmt(product.price));

      // Parchar precio original (tachado) en página de producto
      const $origEl = $price.length
        ? $price.nextAll('[style*="line-through"]').first()
        : $('[style*="line-through"]').filter((_i, el) => /\$[\d,]+\.\d{2}/.test($(el).text())).first();
      if (product.original_price) {
        if ($origEl.length) {
          $origEl.text(fmt(product.original_price));
        } else if ($price.length) {
          $price.after(`<div style="font-size:14px;color:#86868b;text-decoration:line-through;margin-bottom:4px">${esc(fmt(product.original_price))}</div>`);
        }
      } else {
        $origEl.remove();
      }

      // Parchar nombre (h1)
      const $h1 = $('h1').first();
      if ($h1.length) $h1.text(product.name);

      return $.html();
    }

    /* ── Páginas de catálogo / home / categoría ── */
    const activeProducts  = getAllProducts({ active: true });
    const activeSlugsSet  = new Set(activeProducts.map(p => p.slug));

    // Todos los productos del DB para poder mostrar u ocultar
    const allDbProducts = getAllProducts();
    const allBySlug = new Map(allDbProducts.map(p => [p.slug, p]));

    $('.ms-card').each((_i, card) => {
      const $card = $(card);
      const $link = $card.find('a[href^="/producto/"]').first();
      const href  = $link.attr('href') || '';
      const slug  = href.replace('/producto/', '').replace(/\.html.*$/, '').split('?')[0];
      if (!slug) return;

      const product = allBySlug.get(slug);
      const isActive = product && activeSlugsSet.has(slug);

      if (!isActive) {
        // Ocultar (no eliminar) — así si se reactiva vuelve a aparecer
        $card.attr('style', (($card.attr('style') || '').replace(/;?\s*display\s*:[^;]*/gi, '') + ';display:none').replace(/^;/, ''));
        return;
      }

      // Mostrar si estaba oculto
      const cleanStyle = ($card.attr('style') || '').replace(/;?\s*display\s*:\s*none[^;]*/gi, '').trim().replace(/^;+|;+$/g, '');
      if (cleanStyle) $card.attr('style', cleanStyle); else $card.removeAttr('style');

      // Actualizar imagen principal al primer color activo
      const activeColors = (product.color_variants || []).filter(c => c && c.enabled !== false);
      const firstActive  = activeColors[0] || null;
      if (firstActive && firstActive.image_url) {
        $card.find('img').filter((_j, img) => $(img).attr('src') && !$(img).closest('.ms-card-swatch').length)
          .first().attr('src', firstActive.image_url);
      }

      // Parchar swatches (padre de .ms-card-swatch, GrapesJS quita onclick y pone IDs)
      const $firstSwatch = $card.find('.ms-card-swatch').first();
      if ($firstSwatch.length) {
        $firstSwatch.parent().html(buildCardSwatchesHtml(product.color_variants, product));
      }

      // Parchar precio original (tachado) en tarjeta
      const $origSpan = $card.find('span.ms-card-orig, span[style*="line-through"]').first();
      if (product.original_price) {
        if ($origSpan.length) {
          $origSpan.text(fmt(product.original_price));
        } else {
          const $priceSpan = $card.find('span.ms-card-price').first();
          if ($priceSpan.length) {
            $priceSpan.before(`<span class="ms-card-orig" style="margin-right:5px">${esc(fmt(product.original_price))}</span>`);
          }
        }
      } else {
        $origSpan.remove();
      }
      // Parchar precio actual en tarjeta
      const $priceSpan = $card.find('span.ms-card-price').first();
      if ($priceSpan.length) {
        $priceSpan.text(fmt(product.price));
      } else {
        $card.find('span').filter((_j, el) =>
          /^\$[\d,]+\.\d{2}$/.test($(el).text().trim()) &&
          !$(el).hasClass('ms-card-orig') &&
          !($(el).attr('style') || '').includes('line-through')
        ).last().text(fmt(product.price));
      }
    });

    // Ocultar/mostrar secciones showcase (ms-light/ms-dark) con productos inactivos
    const processedContainers = new WeakSet();
    $('a[href^="/producto/"]').each((_i, link) => {
      const $link = $(link);
      const href  = $link.attr('href') || '';
      const slug  = href.replace('/producto/', '').replace(/\.html.*$/, '').split('?')[0];
      if (!slug) return;
      if ($link.closest('.ms-card').length) return; // ya manejado arriba

      // Buscar el contenedor de sección más cercano
      let $container = $link.parent();
      for (let i = 0; i < 10; i++) {
        const cls = $container.attr('class') || '';
        if (cls.includes('ms-dark') || cls.includes('ms-light') ||
            cls.includes('ms-section') || $container.is('section')) break;
        const $p = $container.parent();
        if (!$p.length || $p.is('body, html, main')) break;
        $container = $p;
      }
      const node = $container.get(0);
      if (!node || processedContainers.has(node)) return;
      processedContainers.add(node);

      const isActive = activeSlugsSet.has(slug);
      if (!isActive) {
        $container.attr('style', (($container.attr('style') || '').replace(/;?\s*display\s*:[^;]*/gi, '') + ';display:none').replace(/^;/, ''));
      } else {
        const s = ($container.attr('style') || '').replace(/;?\s*display\s*:\s*none[^;]*/gi, '').trim().replace(/^;+|;+$/g, '');
        if (s) $container.attr('style', s); else $container.removeAttr('style');
      }
    });

    return $.html();
  } catch (e) {
    console.error('[htmlPatch] ERROR para', pageName, e.message);
    return savedHtml;
  }
}

/* Extrae el inline style del logo para sincronizarlo entre páginas */
function extractLogoStyle(html) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html, { decodeEntities: false });
    const $img = $('a.nav-logo img, .nav-logo img').first();
    if (!$img.length) return null;
    return $img.attr('style') || null;
  } catch { return null; }
}

module.exports = { patchSavedHtml, extractLogoStyle };
