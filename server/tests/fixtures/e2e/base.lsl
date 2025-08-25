// Minimal, generic base fixture
#ifndef INCLUDES_BASE_LSL
#define INCLUDES_BASE_LSL

#ifndef DEMO_SECRET
#define DEMO_SECRET "secret"
#endif

// Simple signing: append time and sha256(payload|secret)
string Sign(list parts) {
	parts += [llGetUnixTime()];
	string payload = llDumpList2String(parts, "|");
	string signature = llSHA256String(payload + "|" + DEMO_SECRET);
	return payload + "|" + signature;
}

// Simple verification with 60s skew
list Verify(string msg) {
	list parts = llParseString2List(msg, ["|"], []);
	if (llGetListLength(parts) < 2) return [];
	string signature = llList2String(parts, -1);
	integer ts = llList2Integer(parts, -2);
	if (llAbs(ts - llGetUnixTime()) > 60) return [];
	parts = llList2List(parts, 0, -2);
	string payload = llDumpList2String(parts, "|");
	if (signature != llSHA256String(payload + "|" + DEMO_SECRET)) return [];
	return parts;
}

// Small deterministic hash from secret and input
integer XorValue(string input) {
	string h8 = llGetSubString(llSHA256String(input + "|" + DEMO_SECRET), 0, 7);
	integer i; integer v = 0;
	for (i = 0; i < 8; ++i) {
		string ch = llToLower(llGetSubString(h8, i, i));
		integer n = llSubStringIndex("0123456789abcdef", ch);
		if (n < 0) return 0;
		v = (v << 4) | n;
	}
	return v;
}

#endif
