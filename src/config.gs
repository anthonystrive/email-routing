var LABELS = {
  processed: 'pdf-processed',
  partial: 'pdf-partial',
  failed: 'pdf-failed',
  ignored: 'pdf-ignored'
};

/**
 * Address forms this system accepts from a From header. Deliberately narrow:
 * no angle brackets, commas, parens or quotes inside the address itself.
 */
var ADDR_PATTERN = '[^\\s<>@,()"]+@[^\\s<>@,()"]+';


/**
 * Throws rather than returning empty. A missing hook URL means delivering
 * nowhere; a missing allowlist means accepting every sender. Both are worse
 * silently than loudly.
 */
function getScriptProperty(name) {
  if (!name) {
    // Reached only when this helper is run directly from the editor, which is
    // easy to do by accident: the Run dropdown lists the functions of whatever
    // file is open, and this is the first one in config.gs.
    throw new Error('getScriptProperty is an internal helper and takes an '
      + 'argument — it is not meant to be run directly. Open main.gs and pick '
      + 'one of: dryRun, runOnce, seedBacklog, installTrigger, '
      + 'installSummaryTrigger.');
  }
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) {
    throw new Error('Missing required script property: ' + name
      + '. Set it in Project Settings -> Script Properties.');
  }
  return value;
}

function getHookUrl() {
  return getScriptProperty('ZAPIER_HOOK_URL');
}

/**
 * Where the daily summary is sent.
 *
 * A script property rather than Session.getEffectiveUser().getEmail(), which
 * needs the userinfo.email scope. appsscript.json declares an explicit
 * oauthScopes array, which is authoritative — Apps Script does not top it up
 * — so that call returns '' and sendEmail then throws, meaning the summary
 * never arrives and nobody finds out. Widening the grant to read the account
 * identity is a worse trade than naming the recipient once at setup.
 */
function getSummaryRecipient() {
  return getScriptProperty('SUMMARY_TO');
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
 * Security-critical, and a whitelist by design. RFC 5322 lets a sender hide
 * a decoy address inside a quoted display name or a (possibly nested)
 * comment, and earlier attempts to strip those constructs kept missing
 * variants. So instead of removing what looks dangerous, this accepts only
 * three shapes that are unambiguous, and returns '' for everything else —
 * including multi-mailbox headers and anything with a comment in it. The
 * caller then fails closed.
 *
 * A rejected header shows up as a pdf-ignored label in Gmail, which is
 * visible and recoverable. Silently trusting a forged sender is not.
 */
function extractEmailAddress(from) {
  if (!from) return '';
  var text = String(from).trim();

  // 1. A bare address and nothing else.
  if (new RegExp('^' + ADDR_PATTERN + '$').test(text)) {
    return text.toLowerCase();
  }

  // 2. A quoted display name, then exactly one angle-addr at the very end.
  //    The quoted part may contain anything, including a decoy — it is not
  //    the address, and the trailing angle-addr is.
  var quoted = new RegExp('^"(?:[^"\\\\]|\\\\.)*"\\s*<(' + ADDR_PATTERN + ')>$').exec(text);
  if (quoted) return quoted[1].toLowerCase();

  // 3. An unquoted display name, then exactly one angle-addr at the very
  //    end. The display name may contain a comma ('Smith, John') but not
  //    '@', '<', '>', '(', ')' or '"' — those are how a second address gets
  //    smuggled in.
  var plain = new RegExp('^[^<>()"@]*<(' + ADDR_PATTERN + ')>$').exec(text);
  if (plain) return plain[1].toLowerCase();

  return '';
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
