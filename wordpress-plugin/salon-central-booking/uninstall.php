<?php
// Removes the saved booking link when the plugin is deleted from WordPress.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
delete_option( 'salon_central_booking_url' );
