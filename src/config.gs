var LABELS = {
  processed: 'pdf-processed',
  partial: 'pdf-partial',
  failed: 'pdf-failed',
  ignored: 'pdf-ignored'
};

/**
 * Throws rather than returning empty. A missing hook URL means delivering
 * nowhere; a missing allowlist means accepting every sender. Both are worse
 * silently than loudly.
 */
function getScriptProperty(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) {
    throw new Error('Missing required script property: ' + name);
  }
  return value;
}

function getHookUrl() {
  return getScriptProperty('ZAPIER_HOOK_URL');
}

function getAllowlist() {
  return getScriptProperty('SENDER_ALLOWLIST')
    .split(',')
    .map(function (entry) { return entry.trim().toLowerCase(); })
    .filter(function (entry) { return entry.length > 0; });
}

/**
 * 'Tops Ortho <bookings@example.com>' -> 'bookings@example.com'
 *
 * Security-critical, and deliberately strict. RFC 5322 lets a sender hide a
 * decoy address in places that are not the real address: a quoted-string
 * display name, or a parenthesised comment. Both are stripped before the
 * address is read, and the LAST angle-addr wins — that is where the real
 * address sits in a `display-name angle-addr` mailbox.
 *
 * A `From` carrying several mailboxes is rejected outright: a header
 * claiming two authors, only one of them trusted, is not something this
 * system should try to adjudicate.
 *
 * Anything that does not then look like a single address yields '' so the
 * caller fails closed.
 */
function extractEmailAddress(from) {
  if (!from) return '';
  var text = String(from)
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/\([^()]*\)/g, '');
  if (text.indexOf(',') !== -1) return '';
  var groups = text.match(/<([^<>]+)>/g);
  var address = groups && groups.length
    ? groups[groups.length - 1].slice(1, -1)
    : text;
  address = address.trim().toLowerCase();
  return /^[^\s<>@]+@[^\s<>@]+$/.test(address) ? address : '';
}

/**
 * The security boundary. The mailbox address is effectively public once
 * anyone learns it; without this, a crafted PDF from any sender would flow
 * straight into the practice's downstream systems.
 *
 * An entry starting with '@' matches a whole domain. The leading '@' is what
 * stops 'notclinic.com.au' matching an allowlisted 'clinic.com.au'.
 */
function isAllowedSender(from, allowlist) {
  var address = extractEmailAddress(from);
  if (!address) return false;
  return allowlist.some(function (entry) {
    if (entry.charAt(0) === '@') {
      return address.endsWith(entry);
    }
    return address === entry;
  });
}
