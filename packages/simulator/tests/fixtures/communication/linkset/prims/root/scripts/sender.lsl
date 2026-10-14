integer changes;
integer rhs_evaluations;
string last_chat; // Generic request/reply and cross-prim chat example.

integer bump_rhs()
{
    ++rhs_evaluations;
    return TRUE;
}

default
{
    state_entry()
    {
        integer result = FALSE && bump_rhs();
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

    changed(integer change)
    {
        if (change & CHANGED_OWNER)
        {
            llLinksetDataWrite("owner", (string)llGetOwner());
            llRequestPermissions(
                llGetOwner(),
                PERMISSION_TAKE_CONTROLS
            );
        }
    }

    attach(key id)
    {
        if (id != NULL_KEY)
        {
            llRequestPermissions(
                llGetOwner(),
                PERMISSION_TAKE_CONTROLS
            );
        }
    }

    touch_start(integer count)
    {
        llLinksetDataWrite("boot", "ready");
        llMessageLinked(2, 700, "ping", "request-1");
        llRegionSayTo(llGetLinkKey(2), 42, "hello");
    }

    link_message(integer sender, integer number, string message, key id)
    {
        if (number == 701)
        {
            llLinksetDataWrite(
                "root:reply",
                (string)sender + ":" + message + ":" + (string)id
            );
        }
    }

    listen(integer channel, string name, key id, string message)
    {
        last_chat = message;
        llLinksetDataWrite("root:chat", message);
    }

    linkset_data(integer action, string name, string value)
    {
        ++changes;
    }
}
