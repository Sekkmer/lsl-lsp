// Original minimal simulator example. SPDX-License-Identifier: MIT
integer CHANNEL = -902310;

default
{
    state_entry()
    {
        llListen(CHANNEL, "", NULL_KEY, "ping");
    }

    listen(integer channel, string name, key id, string message)
    {
        // The key field carries the requesting prim's ID through the linkset.
        llMessageLinked(2, 200, message, id);
    }

    link_message(integer sender, integer number, string message, key id)
    {
        if (number == 201)
        {
            llRegionSayTo(id, CHANNEL, message);
        }
    }
}
