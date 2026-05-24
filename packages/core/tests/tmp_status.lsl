default {
	http_response(key rid, integer status, list metadata, string body) {
		integer s = status; // read
		list md = metadata; // read
		string b = body; // read
		// later assignments, not on first lines
		if (s > 0) { rid = NULL_KEY; }
		for (integer i = 0; i < 2; i++) { status += i; }
		llOwnerSay((string)status);
	}
}
