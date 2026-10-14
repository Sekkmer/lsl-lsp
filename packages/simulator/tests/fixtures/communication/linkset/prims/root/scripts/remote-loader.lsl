default // Copy the inventory script into another prim.
{
    touch_start(integer count)
    {
        llRemoteLoadScriptPin(
            llGetLinkKey(2),
            "candidate.lsl",
            1234,
            TRUE,
            0
        );
    }
}
