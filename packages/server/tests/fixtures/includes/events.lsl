// events-only include for testing
state_entry() {
    llSay(0, "ready");
}
listen(integer ch, string name, key id, string msg) {
    llSay(0, msg);
}
