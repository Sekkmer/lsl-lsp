// Compact, generic e2e script that exercises various features.

#define PERM_OWNER 0x01
#define FLAG_ONE   0x10

integer g_Count = 0;
integer g_Flags = 0;

integer Add(integer a, integer b) {
    return a + b;
}
integer Mul(integer a, integer b) {
    return a * b;
}

list MakePayload(string tag, integer v) {
    return [tag, v, llGetUnixTime()];
}

default {
    state_entry() {
        g_Flags = FLAG_ONE;
        integer sum = Add(2, 3);
        integer prod = Mul(sum, 4);
        list payload = MakePayload("hello", prod);
        string msg = llDumpList2String(payload, "|");
        // announce without transitioning
        llOwnerSay(msg);
    }
    touch_start(integer n) {
        g_Count += n;
        llOwnerSay((string)g_Count);
    }
}
