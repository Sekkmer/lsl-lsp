default
{
    state_entry()
    {
        llSetObjectName("Communication Example");
        llLinksetDataWrite("app:name", llGetObjectName());
        llSetRemoteScriptAccessPin(1234);
        llListen(42, "", NULL_KEY, "");
        llRequestPermissions(llGetOwner(), PERMISSION_TAKE_CONTROLS);
    }

    run_time_permissions(integer permissions)
    {
        if (permissions & PERMISSION_TAKE_CONTROLS)
        {
            llTakeControls(CONTROL_FWD, TRUE, TRUE);
        }
    }

    link_message(integer sender, integer number, string message, key id)
    {
        if (number == 700)
        {
            llLinksetDataWrite(
                "app:linked",
                (string)sender + ":" + message + ":" + (string)id
                    + ":" + llLinksetDataRead("boot")
            );
            llMessageLinked(LINK_ROOT, 701, "pong", id);
        }
    }

    listen(integer channel, string name, key id, string message)
    {
        if (message == "hello")
        {
            llLinksetDataWrite("app:chat", message);
            llSay(channel, "ack");
        }
    }
}
