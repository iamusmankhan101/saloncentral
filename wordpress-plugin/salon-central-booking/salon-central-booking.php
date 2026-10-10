<?php
/**
 * Plugin Name:       Salon Central Booking
 * Plugin URI:        https://saloncentral.xyz
 * Description:       Adds your Salon Central online booking form to any page with the Salon Central Booking block or the [salon_central_booking] shortcode. Bookings go straight into your Salon Central dashboard.
 * Version:           1.4.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Salon Central
 * Author URI:        https://saloncentral.xyz
 * License:           GPL-2.0-or-later
 * Text Domain:       salon-central-booking
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SCB_OPTION', 'salon_central_booking_url' );
define( 'SCB_COLOR_OPTION', 'salon_central_booking_color' );
define( 'SCB_LAYOUT_OPTION', 'salon_central_booking_layout' );
define( 'SCB_VERSION', '1.4.0' );
// The only site the form may load from. Links anywhere else are refused, so the
// block/shortcode can't be used to frame other websites on the salon's pages.
define( 'SCB_APP_HOST', 'app.saloncentral.xyz' );

/**
 * A Salon Central booking link (https://app.saloncentral.xyz/book/... or
 * /online-booking?salon=...), or '' for anything else.
 */
function scb_clean_booking_url( $url ) {
	$url = esc_url_raw( trim( (string) $url ), array( 'https' ) );
	if ( ! $url ) {
		return '';
	}
	$parts = wp_parse_url( $url );
	$host  = isset( $parts['host'] ) ? strtolower( $parts['host'] ) : '';
	$path  = isset( $parts['path'] ) ? $parts['path'] : '';
	$ok    = SCB_APP_HOST === $host
		&& empty( $parts['user'] ) && empty( $parts['pass'] ) && empty( $parts['port'] )
		&& ( preg_match( '#^/book/[A-Za-z0-9_-]+/?$#', $path ) || preg_match( '#^/online-booking/?$#', $path ) );
	return $ok ? $url : '';
}

/** The salon's booking link, from the shortcode's/block's url="" or the settings page. */
function scb_booking_url( $override = '' ) {
	return scb_clean_booking_url( $override ? $override : get_option( SCB_OPTION, '' ) );
}

/** A #RRGGBB colour, or '' (meaning: use the salon's own colour from Salon Central). */
function scb_clean_color( $color ) {
	$color = trim( (string) $color );
	return preg_match( '/^#[0-9a-fA-F]{6}$/', $color ) ? strtolower( $color ) : '';
}

/** The button colour: the shortcode's/block's color="" if set, else the settings page's. */
function scb_color( $override = '' ) {
	$color = scb_clean_color( $override );
	return $color ? $color : scb_clean_color( get_option( SCB_COLOR_OPTION, '' ) );
}

/** 'list' (one row per category, the default) or 'grid' (category tiles — a much shorter form). */
function scb_clean_layout( $layout ) {
	return 'grid' === $layout ? 'grid' : 'list';
}

/** The layout: the shortcode's/block's layout="" if set, else the settings page's. */
function scb_layout( $override = '' ) {
	return $override ? scb_clean_layout( $override ) : scb_clean_layout( get_option( SCB_LAYOUT_OPTION, 'list' ) );
}

/** The link the frame loads: the booking link, plus the button colour and layout when chosen. */
function scb_frame_url( $url, $color, $layout = 'list' ) {
	if ( $color ) {
		$url = add_query_arg( 'accent', substr( $color, 1 ), $url );
	}
	if ( 'grid' === $layout ) {
		$url = add_query_arg( 'layout', 'grid', $url );
	}
	return $url;
}

/**
 * [salon_central_booking] — optional attributes:
 *   url="https://app.saloncentral.xyz/book/your-salon"  (overrides the saved link)
 *   color="#b45309"                                      (button colour, overrides the saved one)
 *   layout="grid"                                        (category tiles instead of a list; or "list")
 *   height="900"                                         (starting height in px, before it auto-fits)
 */
function scb_shortcode( $atts ) {
	$atts = shortcode_atts( array( 'url' => '', 'color' => '', 'layout' => '', 'height' => '900' ), $atts, 'salon_central_booking' );
	$url  = scb_booking_url( $atts['url'] );

	if ( ! $url ) {
		// Only editors see the setup hint; visitors see nothing rather than a broken frame.
		if ( current_user_can( 'manage_options' ) ) {
			return '<p style="padding:12px 16px;border:1px dashed #c4b5fd;border-radius:8px;color:#5b21b6;">'
				. esc_html__( 'Salon Central Booking: add your booking link under Settings → Salon Central Booking.', 'salon-central-booking' )
				. '</p>';
		}
		return '';
	}

	wp_enqueue_script( 'salon-central-booking' );
	$height = min( 5000, max( 300, absint( $atts['height'] ) ) );

	// sandbox: the form can run and open new tabs (e.g. directions), but can't
	// navigate or take over the salon's page. referrerpolicy keeps page paths private.
	return sprintf(
		'<div class="scb-wrap"><iframe class="scb-frame" src="%1$s" title="%2$s" loading="lazy" style="width:100%%;height:%3$dpx;border:0;display:block;"'
			. ' sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"'
			. ' referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-write"></iframe></div>',
		esc_url( scb_frame_url( $url, scb_color( $atts['color'] ), scb_layout( $atts['layout'] ) ) ),
		esc_attr__( 'Book an appointment', 'salon-central-booking' ),
		$height
	);
}
add_shortcode( 'salon_central_booking', 'scb_shortcode' );

/**
 * Fits each booking frame to its content (the booking page reports its height),
 * and scrolls the form back into view when the visitor moves to the next step.
 * Messages are only accepted from the frame's own page.
 */
function scb_register_script() {
	wp_register_script( 'salon-central-booking', false, array(), SCB_VERSION, true );
	wp_add_inline_script(
		'salon-central-booking',
		<<<'JS'
(function () {
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data.type !== "string" || data.type.indexOf("salon-central:") !== 0) return;
    var frames = document.querySelectorAll("iframe.scb-frame");
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      if (frame.contentWindow !== event.source) continue;
      if (event.origin !== "https://app.saloncentral.xyz" || new URL(frame.src).origin !== event.origin) return;
      var height = Number(data.height);
      if (data.type === "salon-central:height" && isFinite(height) && height > 0) {
        frame.style.height = Math.min(Math.ceil(height), 20000) + "px";
      } else if (data.type === "salon-central:step" && data.step !== 1) {
        var top = frame.getBoundingClientRect().top;
        if (top < 0) window.scrollBy({ top: top - 20, behavior: "smooth" });
      }
      return;
    }
  });
})();
JS
	);
}
add_action( 'wp_enqueue_scripts', 'scb_register_script' );

/**
 * "Salon Central Booking" block for the block editor. It renders through the
 * shortcode, so both always look the same. The editor shows a simple placeholder
 * (not the live form) so clicks there edit the page instead of booking.
 */
function scb_register_block() {
	if ( ! function_exists( 'register_block_type' ) ) {
		return;
	}
	wp_register_script( 'scb-block-editor', false, array( 'wp-blocks', 'wp-element', 'wp-components', 'wp-block-editor', 'wp-i18n' ), SCB_VERSION, true );
	wp_add_inline_script(
		'scb-block-editor',
		<<<'JS'
(function (blocks, el, components, blockEditor, i18n) {
  var __ = i18n.__;
  blocks.registerBlockType("salon-central/booking", {
    apiVersion: 2,
    title: "Salon Central Booking",
    description: __("Your Salon Central online booking form.", "salon-central-booking"),
    icon: "calendar-alt",
    category: "widgets",
    keywords: ["booking", "appointment", "salon"],
    attributes: { url: { type: "string", default: "" }, color: { type: "string", default: "" }, layout: { type: "string", default: "" } },
    supports: { html: false, align: ["wide", "full"] },
    edit: function (props) {
      var blockProps = blockEditor.useBlockProps({
        style: { padding: "28px 20px", border: "1px dashed #c4b5fd", borderRadius: "10px", background: "#faf8ff", textAlign: "center", color: "#5b21b6" }
      });
      return el("div", blockProps,
        el(blockEditor.InspectorControls, null,
          el(components.PanelBody, { title: __("Booking link", "salon-central-booking") },
            el(components.TextControl, {
              label: __("Different link for this block (optional)", "salon-central-booking"),
              help: __("Leave empty to use the link from Settings → Salon Central Booking. Only Salon Central booking links (https://app.saloncentral.xyz/book/…) work.", "salon-central-booking"),
              value: props.attributes.url,
              onChange: function (url) { props.setAttributes({ url: url }); }
            })
          ),
          el(components.PanelBody, { title: __("Layout", "salon-central-booking") },
            el(components.SelectControl, {
              label: __("Services", "salon-central-booking"),
              value: props.attributes.layout,
              options: [
                { label: __("Same as Settings", "salon-central-booking"), value: "" },
                { label: __("List — one row per category", "salon-central-booking"), value: "list" },
                { label: __("Grid — category tiles (shorter)", "salon-central-booking"), value: "grid" }
              ],
              onChange: function (layout) { props.setAttributes({ layout: layout }); }
            })
          ),
          el(components.PanelBody, { title: __("Button colour", "salon-central-booking") },
            el("p", { style: { fontSize: "12px", color: "#757575", marginTop: 0 } },
              __("Clear it to use the colour from Settings → Salon Central Booking (or the salon's own).", "salon-central-booking")),
            el(components.ColorPalette, {
              value: props.attributes.color || undefined,
              clearable: true,
              onChange: function (color) { props.setAttributes({ color: color || "" }); }
            })
          )
        ),
        el("div", { style: { fontSize: "28px" } }, "📅"),
        el("strong", null, "Salon Central Booking"),
        props.attributes.color && el("span", { style: { display: "inline-block", width: "12px", height: "12px", borderRadius: "50%", background: props.attributes.color, marginLeft: "8px", verticalAlign: "middle" } }),
        el("div", { style: { fontSize: "13px", marginTop: "6px", color: "#6b6b8a" } },
          props.attributes.url || __("Your booking form appears here on the live page.", "salon-central-booking"))
      );
    },
    save: function () { return null; }
  });
})(wp.blocks, wp.element.createElement, wp.components, wp.blockEditor, wp.i18n);
JS
	);
	register_block_type(
		'salon-central/booking',
		array(
			'editor_script'   => 'scb-block-editor',
			'attributes'      => array(
				'url'   => array( 'type' => 'string', 'default' => '' ),
				'color'  => array( 'type' => 'string', 'default' => '' ),
				'layout' => array( 'type' => 'string', 'default' => '' ),
			),
			'render_callback' => function ( $attributes ) {
				return scb_shortcode(
					array(
						'url'   => isset( $attributes['url'] ) ? $attributes['url'] : '',
						'color'  => isset( $attributes['color'] ) ? $attributes['color'] : '',
						'layout' => isset( $attributes['layout'] ) ? $attributes['layout'] : '',
					)
				);
			},
		)
	);
}
add_action( 'init', 'scb_register_block' );

// ─── Settings → Salon Central Booking ──────────────────────────────────────────

function scb_register_setting() {
	register_setting(
		'scb_settings',
		SCB_OPTION,
		array(
			'type'              => 'string',
			'sanitize_callback' => 'scb_sanitize_url',
			'default'           => '',
		)
	);
}
add_action( 'admin_init', 'scb_register_setting' );

function scb_register_color_setting() {
	register_setting(
		'scb_settings',
		SCB_COLOR_OPTION,
		array(
			'type'              => 'string',
			'sanitize_callback' => 'scb_clean_color',
			'default'           => '',
		)
	);
}
add_action( 'admin_init', 'scb_register_color_setting' );

function scb_register_layout_setting() {
	register_setting(
		'scb_settings',
		SCB_LAYOUT_OPTION,
		array(
			'type'              => 'string',
			'sanitize_callback' => 'scb_clean_layout',
			'default'           => 'list',
		)
	);
}
add_action( 'admin_init', 'scb_register_layout_setting' );

/**
 * Settings page only: WordPress's own colour picker, and desktop + phone previews
 * that follow the link, layout and colour fields as they change (before saving).
 */
function scb_admin_assets( $hook ) {
	if ( 'settings_page_salon-central-booking' !== $hook ) {
		return;
	}
	wp_enqueue_style( 'wp-color-picker' );
	wp_enqueue_script( 'wp-color-picker' );
	wp_add_inline_script(
		'wp-color-picker',
		<<<'JS'
jQuery(function ($) {
  var frames = $(".scb-preview-frame"), timer;
  // Same link the plugin builds on the site (scb_frame_url), from the unsaved fields.
  function previewSrc(color) {
    var url;
    try { url = new URL($("#scb-url").val().trim()); } catch (e) { return ""; }
    // Same rule as scb_clean_booking_url(): Salon Central booking links only.
    if (url.protocol !== "https:" || url.host !== "app.saloncentral.xyz" || url.username || url.password) return "";
    if (!/^\/(book\/[A-Za-z0-9_-]+\/?|online-booking\/?)$/.test(url.pathname)) return "";
    var c = color !== undefined ? color : $("#scb-color").val();
    if (/^#[0-9a-f]{6}$/i.test(c)) url.searchParams.set("accent", c.slice(1).toLowerCase());
    if ($("input[name='salon_central_booking_layout']:checked").val() === "grid") url.searchParams.set("layout", "grid");
    return url.toString();
  }
  function refresh(color) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var src = previewSrc(color);
      if (src) frames.each(function () { if (this.src !== src) this.src = src; });
    }, 400);
  }
  $(".scb-color").wpColorPicker({
    change: function (e, ui) { refresh(ui.color.toString()); },
    clear: function () { refresh(""); }
  });
  $("#scb-url").on("input", function () { refresh(); });
  $("input[name='salon_central_booking_layout']").on("change", function () { refresh(); });
});
JS
	);
	wp_add_inline_style(
		'wp-color-picker',
		'.scb-previews{display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start;margin-top:12px}'
		. '.scb-device{margin:0}.scb-device figcaption{font-weight:600;margin:0 0 8px;color:#1d2327}'
		// Desktop: a 1200px-wide page shown at half size in a browser-style frame.
		. '.scb-browser{width:600px;max-width:100%;border:1px solid #c3c4c7;border-radius:10px;overflow:hidden;background:#fff}'
		. '.scb-bar{height:26px;background:#f0f0f1;display:flex;gap:6px;align-items:center;padding:0 12px}'
		. '.scb-bar i{display:block;width:9px;height:9px;border-radius:50%;background:#c3c4c7}'
		. '.scb-desktop .scb-viewport{width:600px;height:640px;overflow:hidden}'
		. '.scb-desktop iframe{width:1200px;height:1280px;border:0;transform:scale(.5);transform-origin:0 0}'
		// Phone: a 375px-wide screen at 80% in a phone outline.
		. '.scb-phone{width:300px;padding:10px;border-radius:38px;background:#1d2327}'
		. '.scb-mobile .scb-viewport{width:300px;height:608px;overflow:hidden;border-radius:28px;background:#fff}'
		. '.scb-mobile iframe{width:375px;height:760px;border:0;transform:scale(.8);transform-origin:0 0}'
	);
}
add_action( 'admin_enqueue_scripts', 'scb_admin_assets' );

function scb_sanitize_url( $value ) {
	$url = scb_booking_url( $value );
	if ( $value && ! $url ) {
		add_settings_error( SCB_OPTION, 'scb_bad_url', __( 'That isn\'t a Salon Central booking link. Copy it from your Salon Central dashboard (Account → Online Booking Link) — it looks like https://app.saloncentral.xyz/book/your-salon', 'salon-central-booking' ) );
	}
	return $url;
}

function scb_add_settings_page() {
	add_options_page(
		__( 'Salon Central Booking', 'salon-central-booking' ),
		__( 'Salon Central Booking', 'salon-central-booking' ),
		'manage_options',
		'salon-central-booking',
		'scb_render_settings_page'
	);
}
add_action( 'admin_menu', 'scb_add_settings_page' );

function scb_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$url = get_option( SCB_OPTION, '' );
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Salon Central Booking', 'salon-central-booking' ); ?></h1>
		<p><?php esc_html_e( 'Show your Salon Central booking form on your website. Bookings go straight into your Salon Central dashboard, with the same services, staff and opening hours.', 'salon-central-booking' ); ?></p>

		<form method="post" action="options.php">
			<?php settings_fields( 'scb_settings' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="scb-url"><?php esc_html_e( 'Your booking link', 'salon-central-booking' ); ?></label></th>
					<td>
						<input id="scb-url" type="url" class="regular-text code" name="<?php echo esc_attr( SCB_OPTION ); ?>"
							value="<?php echo esc_attr( $url ); ?>" placeholder="https://app.saloncentral.xyz/book/your-salon" />
						<p class="description"><?php esc_html_e( 'Find it in your Salon Central dashboard under Account → Online Booking Link, and copy it here.', 'salon-central-booking' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Layout', 'salon-central-booking' ); ?></th>
					<td>
						<?php $layout = scb_layout(); ?>
						<fieldset>
							<label><input type="radio" name="<?php echo esc_attr( SCB_LAYOUT_OPTION ); ?>" value="list" <?php checked( 'list', $layout ); ?> />
								<?php esc_html_e( 'List — one row per service category', 'salon-central-booking' ); ?></label><br />
							<label><input type="radio" name="<?php echo esc_attr( SCB_LAYOUT_OPTION ); ?>" value="grid" <?php checked( 'grid', $layout ); ?> />
								<?php esc_html_e( 'Grid — categories as tiles, a much shorter form', 'salon-central-booking' ); ?></label>
						</fieldset>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="scb-color"><?php esc_html_e( 'Button colour', 'salon-central-booking' ); ?></label></th>
					<td>
						<input id="scb-color" type="text" class="scb-color" name="<?php echo esc_attr( SCB_COLOR_OPTION ); ?>"
							value="<?php echo esc_attr( scb_clean_color( get_option( SCB_COLOR_OPTION, '' ) ) ); ?>" data-default-color="" />
						<p class="description"><?php esc_html_e( 'Colour for buttons, selected items and the step bar — pick one that matches your website. Leave empty (Clear) to use your salon colour from Salon Central.', 'salon-central-booking' ); ?></p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>

		<h2><?php esc_html_e( 'Add it to a page', 'salon-central-booking' ); ?></h2>
		<p><?php esc_html_e( 'Edit any page and add the "Salon Central Booking" block (search for "booking" in the block menu).', 'salon-central-booking' ); ?></p>
		<p><?php esc_html_e( 'Using the Classic editor or a page builder? Paste this shortcode instead:', 'salon-central-booking' ); ?> <code>[salon_central_booking]</code></p>

		<?php if ( $url ) : ?>
			<?php $preview = scb_frame_url( $url, scb_color(), scb_layout() ); ?>
			<h2><?php esc_html_e( 'Preview', 'salon-central-booking' ); ?></h2>
			<p class="description"><?php esc_html_e( 'Updates as you change the layout or colour above. Click Save Changes to use them on your website.', 'salon-central-booking' ); ?></p>
			<div class="scb-previews">
				<figure class="scb-device scb-desktop">
					<figcaption><?php esc_html_e( 'Desktop', 'salon-central-booking' ); ?></figcaption>
					<div class="scb-browser">
						<div class="scb-bar"><i></i><i></i><i></i></div>
						<div class="scb-viewport">
							<iframe class="scb-preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="strict-origin-when-cross-origin" src="<?php echo esc_url( $preview ); ?>" title="<?php esc_attr_e( 'Desktop preview', 'salon-central-booking' ); ?>"></iframe>
						</div>
					</div>
				</figure>
				<figure class="scb-device scb-mobile">
					<figcaption><?php esc_html_e( 'Mobile', 'salon-central-booking' ); ?></figcaption>
					<div class="scb-phone">
						<div class="scb-viewport">
							<iframe class="scb-preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="strict-origin-when-cross-origin" src="<?php echo esc_url( $preview ); ?>" title="<?php esc_attr_e( 'Mobile preview', 'salon-central-booking' ); ?>"></iframe>
						</div>
					</div>
				</figure>
			</div>
		<?php endif; ?>
	</div>
	<?php
}

/** A "Settings" link next to the plugin on the Plugins screen. */
function scb_action_links( $links ) {
	array_unshift(
		$links,
		'<a href="' . esc_url( admin_url( 'options-general.php?page=salon-central-booking' ) ) . '">' . esc_html__( 'Settings', 'salon-central-booking' ) . '</a>'
	);
	return $links;
}
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), 'scb_action_links' );
