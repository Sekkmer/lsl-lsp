// Minimal derive fixture exercising base API
#include "base.lsl"

integer g_Channel = -1;

default {
	state_entry() {
		g_Channel = (integer)llFrand(-1000000.0) - 1000000;
		string msg = Sign(["hello", g_Channel]);
		list parts = Verify(msg);
		if (llGetListLength(parts) >= 2) {
			integer combined = llList2Integer(parts, 1) ^ XorValue(llGetScriptName());
			llOwnerSay((string)combined);
		}
		state ready;
	}
}

state ready {
	state_entry() {
		// noop, just a second state
	}
}
