#define DEBUG 1
#include "inc.lsl"

integer g = 7;

state default {
	state_entry() {
		integer x = 1;
#ifdef DEBUG
		llSay(0, "dbg");
#endif
		x = g;
		llSay(0, "live");
	}
}
