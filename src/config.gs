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

/** 'Tops Ortho <bookings@example.com>' -> 'bookings@example.com' */
function extractEmailAddress(from) {
  if (!from) return '';
  var match = /<([^>]+)>/.exec(String(from));
  return (match ? match[1] : String(from)).trim().toLowerCase();
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
