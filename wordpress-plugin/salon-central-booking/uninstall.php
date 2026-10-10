<?php
// Removes everything the plugin saved when it's deleted from WordPress.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
delete_option( 'salon_central_booking_url' );
delete_option( 'salon_central_booking_color' );
delete_option( 'salon_central_booking_layout' );
