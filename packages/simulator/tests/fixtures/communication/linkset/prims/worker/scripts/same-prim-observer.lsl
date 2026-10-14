default // Same-prim scripts do not hear object chat from their prim.
{
    state_entry()
    {
        llListen(42, "", NULL_KEY, "ack");
    }

    listen(integer channel, string name, key id, string message)
    {
        llLinksetDataWrite("same-prim:ack", message);
    }
}
