// Original minimal simulator example. SPDX-License-Identifier: MIT
integer CHANNEL = -902310;

default
{
    state_entry()
    {
        llListen(CHANNEL, "", NULL_KEY, "pong");
    }

    touch_start(integer count)
    {
        // Nonzero avatar-targeted chat reaches that avatar's attachments.
        llRegionSayTo(llGetOwner(), CHANNEL, "ping");
    }

    listen(integer channel, string name, key id, string message)
    {
        llLinksetDataWrite("panel:reply", message);
    }
}
