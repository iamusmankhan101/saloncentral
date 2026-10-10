=== Salon Central Booking ===
Contributors: saloncentral
Tags: booking, appointments, salon, spa, beauty
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.4.0
License: GPLv2 or later

Show your Salon Central online booking form on your website. Bookings go straight into your Salon Central dashboard.

== Description ==

Clients pick services, staff, date and time on your own website. The booking lands in your Salon Central dashboard with the same services, prices, staff and opening hours, and your usual WhatsApp confirmations go out.

The form always matches your Salon Central settings — change a price or add a service in Salon Central and your website shows it straight away.

== Installation ==

1. Plugins → Add New → Upload Plugin, choose salon-central-booking.zip, then Install and Activate.
2. Settings → Salon Central Booking: paste your booking link (Salon Central dashboard → Account → Online Booking Link) and Save.
3. Edit the page where you want the form and add the "Salon Central Booking" block. (Classic editor or a page builder: paste [salon_central_booking] instead.)

== Frequently Asked Questions ==

= Can I use a different link on one page? =
Yes. In the block's sidebar, fill in "Different link for this block". With the shortcode: [salon_central_booking url="https://app.saloncentral.xyz/book/other-branch"]

= Can I change the button colour? =
Yes. Settings → Salon Central Booking → Button colour sets it for every form. A single block can have its own colour in the block's sidebar, or with the shortcode: [salon_central_booking color="#b45309"]. Leave it empty to use your salon colour from Salon Central.

= The form is too long =
Choose the Grid layout under Settings → Salon Central Booking → Layout. Service categories then show as tiles in a few columns instead of one row each. Per block: the block's sidebar → Layout. Shortcode: [salon_central_booking layout="grid"]

= The form is cut off before the page has loaded =
It resizes itself once it loads. To change the starting height: [salon_central_booking height="1100"]

== Changelog ==

= 1.4.0 =
* Security: only Salon Central booking links (https://app.saloncentral.xyz/book/…) are accepted, so the block and shortcode can't be used to show other websites.
* Security: the form runs in a restricted (sandboxed) frame that can't navigate or take over your page; size messages are validated.
* Deleting the plugin now removes all of its saved settings.

= 1.3.0 =
* Settings page shows desktop and mobile previews side by side, updating live as you change the layout or colour.

= 1.2.0 =
* Layout option: List (default) or Grid — service categories as tiles for a much shorter form.

= 1.1.0 =
* Button colour option (settings page, block sidebar, shortcode color="").
* The embedded form shows just the booking card, without the salon banner.

= 1.0.0 =
* First release.
