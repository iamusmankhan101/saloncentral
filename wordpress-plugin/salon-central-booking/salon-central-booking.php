<?php
/**
 * Plugin Name:       Salon Central Booking
 * Plugin URI:        https://saloncentral.xyz
 * Description:       Adds your Salon Central online booking form to any page with the Salon Central Booking block or the [salon_central_booking] shortcode. Bookings go straight into your Salon Central dashboard.
 * Version:           1.1.0
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

/**
 * The salon's booking link, from the shortcode's url="" or the settings page.
 * Only https links are accepted.
 */
function scb_booking_url( $override = '' ) {
	$url = $override ? $override : get_option( SCB_OPTION, '' );
	$url = esc_url_raw( trim( (string) $url ), array( 'https' ) );
	return $url;
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

/** The link the frame loads: the booking link, plus the button colour when one is chosen. */
function scb_frame_url( $url, $color ) {
	return $color ? add_query_arg( 'accent', substr( $color, 1 ), $url ) : $url;
}

/**
 * [salon_central_booking] — optional attributes:
 *   url="https://app.saloncentral.xyz/book/your-salon"  (overrides the saved link)
 *   color="#b45309"                                      (button colour, overrides the saved one)
 *   height="900"                                         (starting height in px, before it auto-fits)
 */
function scb_shortcode( $atts ) {
	$atts = shortcode_atts( array( 'url' => '', 'color' => '', 'height' => '900' ), $atts, 'salon_central_booking' );
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
	$height = max( 300, absint( $atts['height'] ) );

	return sprintf(
		'<div class="scb-wrap"><iframe class="scb-frame" src="%1$s" title="%2$s" loading="lazy" style="width:100%%;height:%3$dpx;border:0;display:block;" allow="clipboard-write"></iframe></div>',
		esc_url( scb_frame_url( $url, scb_color( $atts['color'] ) ) ),
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
	wp_register_script( 'salon-central-booking', false, array(), '1.0.0', true );
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
      if (new URL(frame.src).origin !== event.origin) return;
      if (data.type === "salon-central:height" && data.height > 0) {
        frame.style.height = Math.ceil(data.height) + "px";
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
	wp_register_script( 'scb-block-editor', false, array( 'wp-blocks', 'wp-element', 'wp-components', 'wp-block-editor', 'wp-i18n' ), '1.0.0', true );
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
    attributes: { url: { type: "string", default: "" }, color: { type: "string", default: "" } },
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
              help: __("Leave empty to use the link from Settings → Salon Central Booking.", "salon-central-booking"),
              value: props.attributes.url,
              onChange: function (url) { props.setAttributes({ url: url }); }
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
				'color' => array( 'type' => 'string', 'default' => '' ),
			),
			'render_callback' => function ( $attributes ) {
				return scb_shortcode(
					array(
						'url'   => isset( $attributes['url'] ) ? $attributes['url'] : '',
						'color' => isset( $attributes['color'] ) ? $attributes['color'] : '',
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

/** WordPress's own colour picker, on this plugin's settings page only. */
function scb_admin_assets( $hook ) {
	if ( 'settings_page_salon-central-booking' !== $hook ) {
		return;
	}
	wp_enqueue_style( 'wp-color-picker' );
	wp_enqueue_script( 'wp-color-picker' );
	wp_add_inline_script( 'wp-color-picker', 'jQuery(function ($) { $(".scb-color").wpColorPicker(); });' );
}
add_action( 'admin_enqueue_scripts', 'scb_admin_assets' );

function scb_sanitize_url( $value ) {
	$url = scb_booking_url( $value );
	if ( $value && ! $url ) {
		add_settings_error( SCB_OPTION, 'scb_bad_url', __( 'Please paste your full booking link, starting with https://', 'salon-central-booking' ) );
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
			<h2><?php esc_html_e( 'Preview', 'salon-central-booking' ); ?></h2>
			<iframe src="<?php echo esc_url( scb_frame_url( $url, scb_color() ) ); ?>" title="<?php esc_attr_e( 'Booking form preview', 'salon-central-booking' ); ?>"
				style="width:100%;max-width:520px;height:640px;border:1px solid #dcdcde;border-radius:8px;background:#fff;"></iframe>
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
